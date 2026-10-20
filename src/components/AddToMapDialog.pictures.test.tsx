import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost } from "./testing/dom-host";
import { AddToMapDialog } from "./AddToMapDialog";

/**
 * The add-to-map dialog's cards: while one waits for its picture, the
 * dialog asks the maps listing again every five seconds until none waits,
 * and the new picture shows on its card with no reload. The listing is
 * the browser's fetch.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./theme", () => ({ useTheme: () => ({ theme: "dark" }) }));

const map = (id: string, picture: object) => ({
  id, name: `Map ${id}`, editRevision: "r1", layerCount: 1, updatedAt: "2026-10-01T00:00:00Z", published: false,
  pictureState: "current", pictureVersion: null, hasThumbnail: false, thumbnailBasemap: null, ...picture,
});
let listing: object[];
let asked: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  asked = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/maps") { asked.push(url); return Response.json(listing); }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  root = createRoot(host.document.body as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const pictureOf = (name: string) =>
  host.document.querySelectorAll("button").find((b) => b.textContent.includes(name))?.querySelector("img")?.getAttribute("src") ?? null;

it("asks the maps listing every five seconds while a card waits, and shows the new picture on its card", async () => {
  listing = [map("a", { pictureState: "waiting" }), map("b", { pictureVersion: "server-4", hasThumbnail: true })];
  await act(async () => root.render(<AddToMapDialog subject={{ sql: "SELECT 1", name: "Result", label: "Result" }} onClose={() => {}} />));
  await pass(0);
  expect(asked).toEqual(["/api/maps"]);
  expect(pictureOf("Map a")).toBeNull();
  expect(pictureOf("Map b")).toBe("/api/maps/b/thumbnail?v=server-4&theme=dark");
  listing = [map("a", { pictureVersion: "server-1", hasThumbnail: true }), map("b", { pictureVersion: "server-4", hasThumbnail: true })];
  await pass(5_000);
  expect(asked).toEqual(["/api/maps", "/api/maps"]);
  expect(pictureOf("Map a")).toBe("/api/maps/a/thumbnail?v=server-1&theme=dark");
  await pass(60_000);
  expect(asked).toHaveLength(2);
});

it("asks nothing again when no card waits", async () => {
  listing = [map("a", { pictureVersion: "server-1", hasThumbnail: true }), map("b", { pictureState: "failed" })];
  await act(async () => root.render(<AddToMapDialog subject={{ sql: "SELECT 1", name: "Result", label: "Result" }} onClose={() => {}} />));
  await pass(60_000);
  expect(asked).toEqual(["/api/maps"]);
});
