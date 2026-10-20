import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { MapStrip } from "./MapStrip";
import { PictureCredit } from "./PictureCredit";
import { PicturePoll } from "./PicturePoll";
import type { PictureCard } from "./picture-poll";

/**
 * A page's poll for its cards' pictures, on a clock the test drives: no
 * ask while no card waits; while one does, an ask every five seconds, the
 * next timed from the last answer, so never two at once; the new picture
 * shown and credited as it lands, with no reload; a failed ask keeping
 * what is shown and the next one asking again; and nothing asked once no
 * card waits or the page is gone. The owner's own newer read stands over
 * an older answer, even one that says just what the card said when asked.
 */

vi.mock("./theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: () => <i data-placeholder="" /> }));

const map = (id: string, picture: Partial<MapOverview> = {}): MapOverview => ({
  id, name: `Map ${id}`, basemap: null, customBasemap: null, basemapLayers: null,
  pictureState: "waiting", pictureVersion: null, hasThumbnail: false, thumbnailBasemap: null, ...picture,
}) as unknown as MapOverview;
const landed = { pictureState: "current", pictureVersion: "server-1", hasThumbnail: true } as const;

/** A read the test answers by hand, one deferred answer per ask. */
function deferredRead() {
  const asks: { resolve: (cards: PictureCard[]) => void; reject: (error: Error) => void }[] = [];
  const read = vi.fn(() => new Promise<PictureCard[]>((resolve, reject) => { asks.push({ resolve, reject }); }));
  return { read, asks, answer: async (cards: PictureCard[]) => { await act(async () => { asks.at(-1)!.resolve(cards); }); },
    fail: async () => { await act(async () => { asks.at(-1)!.reject(new Error("down")); }); } };
}

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.useRealTimers();
});

async function draw(cards: MapOverview[], read: () => Promise<readonly PictureCard[]>) {
  await act(async () => root.render(
    <PicturePoll cards={cards} read={read}>
      {cards.map((m) => <span key={m.id} data-card={m.id}><MapStrip map={m} /></span>)}
      <PictureCredit maps={cards} placement="page" />
    </PicturePoll>,
  ));
}
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const shownSrc = (id: string) =>
  container.querySelector(`[data-card="${id}"]`)?.querySelector("img")?.getAttribute("src") ?? null;
const credit = () => container.querySelector("[data-picture-credit]")?.textContent ?? null;

describe("a page's poll for its cards' pictures", () => {
  it("asks nothing while no card it draws waits", async () => {
    const poll = deferredRead();
    await draw([map("a", landed), map("b", { pictureState: "failed" }), map("c", { pictureState: "unavailable" })], poll.read);
    await pass(60_000);
    expect(poll.read).not.toHaveBeenCalled();
  });

  it("asks every five seconds while a card waits, one ask at a time, and stops once none waits", async () => {
    const poll = deferredRead();
    const cards = [map("a"), map("b", landed)];
    await draw(cards, poll.read);
    await pass(4_999);
    expect(poll.read).not.toHaveBeenCalled();
    await pass(1);
    expect(poll.read).toHaveBeenCalledTimes(1);
    // An ask still out holds the next one back, however long it takes.
    await pass(30_000);
    expect(poll.read).toHaveBeenCalledTimes(1);
    await poll.answer([map("a"), map("b", landed)]);
    await pass(4_999);
    expect(poll.read).toHaveBeenCalledTimes(1);
    await pass(1);
    expect(poll.read).toHaveBeenCalledTimes(2);
    await poll.answer([map("a", landed), map("b", landed)]);
    await pass(60_000);
    expect(poll.read).toHaveBeenCalledTimes(2);
  });

  it("never asks twice at once, even when the owner's own reads move the card out of waiting and back meanwhile", async () => {
    const poll = deferredRead();
    await draw([map("a")], poll.read);
    await pass(5_000);
    expect(poll.read).toHaveBeenCalledTimes(1);
    await draw([map("a", landed)], poll.read);
    await draw([map("a", { pictureState: "waiting", pictureVersion: "server-1", hasThumbnail: true })], poll.read);
    await pass(30_000);
    expect(poll.read).toHaveBeenCalledTimes(1);
    await poll.answer([map("a", { pictureState: "waiting", pictureVersion: "server-1", hasThumbnail: true })]);
    await pass(5_000);
    expect(poll.read).toHaveBeenCalledTimes(2);
  });

  it("shows and credits the new picture as it lands, with no reload, and the card's previous picture until then", async () => {
    const poll = deferredRead();
    const before = map("a", { pictureState: "waiting", pictureVersion: "old-2026-10-01T00:00:00Z", hasThumbnail: true });
    await draw([before], poll.read);
    expect(shownSrc("a")).toBe("/api/maps/a/thumbnail?v=old-2026-10-01T00%3A00%3A00Z&theme=light");
    await pass(5_000);
    const drawn = { url: "https://style.test/a.json", kind: "vector" as const, custom: false, attribution: [{ label: "© Test" }] };
    await poll.answer([map("a", { ...landed, thumbnailBasemap: drawn })]);
    expect(shownSrc("a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
    expect(credit()).toBe("Map previews:© Test");
  });

  it("keeps what is shown when an ask fails, and asks again five seconds after it", async () => {
    const poll = deferredRead();
    await draw([map("a", { pictureVersion: "server-1", hasThumbnail: true })], poll.read);
    await pass(5_000);
    await poll.fail();
    expect(shownSrc("a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
    await pass(5_000);
    expect(poll.read).toHaveBeenCalledTimes(2);
  });

  it("asks nothing more once the page is gone, an answer still out landing nowhere", async () => {
    const poll = deferredRead();
    await draw([map("a")], poll.read);
    await pass(5_000);
    act(() => root.unmount());
    await act(async () => { poll.asks[0].resolve([map("a", landed)]); });
    await pass(60_000);
    expect(poll.read).toHaveBeenCalledTimes(1);
    root = createRoot(container as unknown as Element);
  });

  it("lets the owner's own newer read stand over an answer asked before it, and stops when that read has none waiting", async () => {
    const poll = deferredRead();
    await draw([map("a")], poll.read);
    await pass(5_000);
    await poll.answer([map("a", { pictureState: "waiting", pictureVersion: "server-1", hasThumbnail: true })]);
    expect(shownSrc("a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=light");
    // The owner reads its listing again and holds a newer picture.
    await draw([map("a", { pictureState: "current", pictureVersion: "server-2", hasThumbnail: true })], poll.read);
    expect(shownSrc("a")).toBe("/api/maps/a/thumbnail?v=server-2&theme=light");
    await pass(60_000);
    expect(poll.read).toHaveBeenCalledTimes(1);
  });

  it("lets the owner's newer read stand over an older answer though it says just what the card said when asked, and asks again while it waits", async () => {
    const poll = deferredRead();
    const onOne = { pictureState: "waiting", pictureVersion: "server-1", hasThumbnail: true } as const;
    await draw([map("a", onOne)], poll.read);
    await pass(5_000);
    await poll.answer([map("a", { ...onOne, pictureState: "failed" })]);
    // The failure is laid over the card, so nothing on the page waits.
    await pass(60_000);
    expect(poll.read).toHaveBeenCalledTimes(1);
    // The work is tried again and the owner reads its listing again (another
    // scope, say): the card waits again, on the same picture as when asked.
    await draw([map("a", onOne)], poll.read);
    await pass(5_000);
    expect(poll.read).toHaveBeenCalledTimes(2);
  });

  it("lays no answer over a read the owner made while it was out, though the picture facts read the same", async () => {
    const poll = deferredRead();
    const onOne = { pictureState: "waiting", pictureVersion: "server-1", hasThumbnail: true } as const;
    await draw([map("a", onOne)], poll.read);
    await pass(5_000);
    await draw([map("a", onOne)], poll.read);
    await poll.answer([map("a", { ...onOne, pictureState: "failed" })]);
    await pass(5_000);
    expect(poll.read).toHaveBeenCalledTimes(2);
  });
});
