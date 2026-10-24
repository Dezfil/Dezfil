import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { cssRules } from "../testing/css-rules";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { DISPLAY_NAME_EVENT } from "../UserBadge";
import { AccountPicture } from "./AccountPicture";

/**
 * One's own picture on the Account card: a chosen file is sent at once,
 * with no Save, and Remove shows while there is a picture. The card draws
 * only its latest request's answer, so an earlier answer arriving last
 * never brings back an older picture; a refusal keeps the picture there
 * was and says why in the server's words; each change tells the side menu.
 * The server is a fake answered by hand.
 */

const ADA: Account = {
  id: "ada", name: "Ada Byron Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: false, status: "active",
  isOriginal: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastSignInAt: null,
};

interface Call { url: string; method: string; file: string | null; answer: (status: number, body: unknown) => Promise<void> }
let calls: Call[];
let told: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  calls = []; told = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => new Promise<Response>(resolve => {
    expect(["/api/account/picture", "/api/account"]).toContain(url);
    const sent = init.body instanceof FormData ? init.body.get("file") : null;
    calls.push({ url, method: init.method ?? "GET", file: sent instanceof File ? sent.name : null,
      answer: async (status, body) => { await act(async () => { resolve(Response.json(body, { status })); await new Promise(r => setTimeout(r, 0)); }); } });
  })));
  host = installDomHost();
  host.window.addEventListener(DISPLAY_NAME_EVENT, (event: unknown) => { told.push((event as CustomEvent<string>).detail); });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function draw(account: Account = ADA) {
  await act(async () => root.render(<AccountPicture account={account} />));
}
const face = () => container.querySelector("[data-face]")!;
const picture = () => face().querySelector("img")?.getAttribute("src") ?? null;
const buttons = () => container.querySelectorAll("button").map(button => button.textContent);
const button = (label: string) => container.querySelectorAll("button").find(element => element.textContent === label)!;
const note = () => container.querySelector('[role="alert"]')?.textContent ?? null;
/** A file chosen in the hidden chooser: its React handler, as the node host fires no change events. */
async function choose(name: string) {
  const input = container.querySelector("input[data-picture-file]")!;
  const key = Object.keys(input).find(k => k.startsWith("__reactProps$"))!;
  const target = { files: [new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" })], value: name };
  await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target }));
  return target;
}
const click = (label: string) => act(async () => { button(label).click(); });
const pictured = (version?: string) => ({ account: { ...ADA, ...(version ? { pictureVersion: version } : {}) } });

describe("one's own picture on the Account card", () => {
  it("shows the first two initials without a picture, and offers Change but no Remove", async () => {
    await draw();
    expect(face().textContent).toBe("AB");
    expect(picture()).toBeNull();
    expect(buttons()).toEqual(["Change"]);
    expect(container.querySelector("input[data-picture-file]")?.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp");
  });

  it("sends a chosen file at once, draws the answer's picture, offers Remove and tells the side menu", async () => {
    await draw();
    const chosen = await choose("ada.png");
    expect(chosen.value).toBe("");
    expect(calls.map(call => [call.method, call.file])).toEqual([["PUT", "ada.png"]]);
    expect(button("Change").getAttribute("aria-busy")).toBe("true");
    await calls[0].answer(200, pictured("p1"));
    expect(picture()).toBe("/api/accounts/ada_okafor/picture?v=p1");
    expect(buttons()).toEqual(["Change", "Remove"]);
    expect(told).toEqual([ADA.name]);
  });

  it("removes the picture at once, back to the initials, and tells the side menu", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    expect(picture()).toBe("/api/accounts/ada_okafor/picture?v=p1");
    await click("Remove");
    expect(calls.map(call => [call.method, call.file])).toEqual([["DELETE", null]]);
    await calls[0].answer(200, pictured());
    expect(picture()).toBeNull();
    expect(face().textContent).toBe("AB");
    expect(buttons()).toEqual(["Change"]);
    expect(told).toEqual([ADA.name]);
  });

  it("keeps the picture there was when a change is refused, and says why in the server's words", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await choose("notes.jpg");
    await calls[0].answer(415, { error: { code: "unsupported_image", message: "Choose a JPEG, PNG or WebP image." } });
    expect(note()).toContain("Choose a JPEG, PNG or WebP image.");
    expect(picture()).toBe("/api/accounts/ada_okafor/picture?v=p1");
    expect(told).toEqual([]);
    await choose("ada.webp");
    expect(note()).toBeNull();
  });

  it("draws only the latest request's answer: an earlier upload answering after a later removal leaves no picture", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await choose("slow.png");
    await click("Remove");
    expect(calls.map(call => call.method)).toEqual(["PUT", "DELETE"]);
    await calls[1].answer(200, pictured());
    expect(picture()).toBeNull();
    await calls[0].answer(200, pictured("p2"));
    expect(picture()).toBeNull();
    expect(buttons()).toEqual(["Change"]);
  });

  it("keeps the newer picture when an older removal's answer arrives after it", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await click("Remove");
    await choose("second.png");
    expect(calls.map(call => call.method)).toEqual(["DELETE", "PUT"]);
    await calls[1].answer(200, pictured("p2"));
    expect(picture()).toBe("/api/accounts/ada_okafor/picture?v=p2");
    await calls[0].answer(200, pictured());
    expect(picture()).toBe("/api/accounts/ada_okafor/picture?v=p2");
    expect(buttons()).toEqual(["Change", "Remove"]);
  });

  it("ignores an older request's refusal once a newer one has answered", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await click("Remove");
    await choose("second.png");
    await calls[1].answer(200, pictured("p2"));
    await calls[0].answer(503, { error: { code: "unavailable", message: "Please try again." } });
    expect(note()).toBeNull();
    expect(picture()).toBe("/api/accounts/ada_okafor/picture?v=p2");
  });

  it("reads the account again once overlapping requests settle: a late removal behind a refused upload leaves no picture", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await click("Remove");
    await choose("notes.jpg");
    await calls[1].answer(415, { error: { code: "unsupported_image", message: "Choose a JPEG, PNG or WebP image." } });
    expect(note()).toContain("Choose a JPEG, PNG or WebP image.");
    await calls[0].answer(200, pictured());
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ["DELETE", "/api/account/picture"], ["PUT", "/api/account/picture"], ["GET", "/api/account"],
    ]);
    await calls[2].answer(200, pictured());
    expect(picture()).toBeNull();
    expect(buttons()).toContain("Change");
    expect(buttons()).not.toContain("Remove");
    expect(note()).toContain("Choose a JPEG, PNG or WebP image.");
    expect(told).toEqual([ADA.name]);
  });

  it("keeps Remove open while an upload is on its way, and Change while a removal is", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await choose("slow.png");
    expect(button("Remove").disabled).toBe(false);
    await click("Remove");
    expect(button("Change").disabled).toBe(false);
  });

  it("removes again harmlessly from a second card that still shows the removed picture", async () => {
    await draw({ ...ADA, pictureVersion: "p1" });
    await click("Remove");
    await calls[0].answer(200, pictured());
    await act(async () => root.render(<AccountPicture key="second" account={{ ...ADA, pictureVersion: "p1" }} />));
    await click("Remove");
    await calls[1].answer(200, pictured());
    expect(calls.map(call => call.method)).toEqual(["DELETE", "DELETE"]);
    expect(note()).toBeNull();
    expect(picture()).toBeNull();
  });
});

describe("the card's picture stylesheet", () => {
  it("draws the face no larger than 96 points across, round", () => {
    const face = cssRules("src/components/settings/AccountPicture.module.css").filter(rule => rule.selector === ".face").map(rule => rule.body).join(";");
    expect(face).toMatch(/width:\s*96px/);
    expect(face).toMatch(/height:\s*96px/);
    expect(face).toMatch(/border-radius:\s*50%/);
  });
});
