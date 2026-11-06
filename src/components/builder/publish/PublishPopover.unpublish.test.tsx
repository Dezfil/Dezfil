import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { HostElement, HostEvent, installDomHost } from "../../testing/dom-host";
import { PublishControl } from "./PublishControl";

/**
 * Unpublish asks first. The question reads word for word; opening it,
 * Cancel and Escape send nothing and leave the panel open; a press on the
 * question never closes the panel under it; Unpublish map sends one
 * request, and a refusal or a lost connection stays in the question.
 */
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));

const map = {
  id: "m", name: "Station catchments", layers: [], updatedAt: "2026-10-08T00:00:00Z",
  publishToken: "token-owner", publishedAt: "2026-10-01T00:00:00Z", published: true,
} as unknown as MapWithLayers;

type Held = { resolve: (response: Response) => void; reject: (error: unknown) => void };
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>, container: HostElement;
let deletes: Held[];
const changed = vi.fn();

beforeEach(() => {
  deletes = []; changed.mockClear();
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/maps/m/publish" && init?.method === "DELETE") {
      return new Promise<Response>((resolve, reject) => { deletes.push({ resolve, reject }); });
    }
    if (url === "/api/config") return Promise.resolve(Response.json({ rules: { "publishing.publish": "everyone", "publishing.embedding": "any" } }));
    if (url === "/api/account") return Promise.resolve(Response.json({ account: { id: "a1", isAdmin: false } }));
    if (url === "/api/maps/m/published-fields") return Promise.resolve(Response.json({ layers: [] }));
    if (url === "/api/maps/m/publish") {
      return Promise.resolve(Response.json({ token: "token-owner", publishedAt: "2026-10-01T00:00:00Z", theme: "light",
        viewerControls: { tilt: true, fit: true, theme: true, basemap: true, coords: false } }));
    }
    return Promise.resolve(Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 }));
  }));
  host = installDomHost();
  Object.assign(host.window, { location: { origin: "https://maps.example.test" }, innerHeight: 900 });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  // The host computes no layout; the panel's measure reads a stand-in.
  Object.defineProperty(HostElement.prototype, "getBoundingClientRect", {
    configurable: true, value: () => ({ top: 14, bottom: 50, left: 0, right: 0, width: 0, height: 36 }),
  });
  Object.defineProperty(HostElement.prototype, "offsetTop", { configurable: true, get: () => 44 });
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  delete (HostElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
  delete (HostElement.prototype as unknown as Record<string, unknown>).offsetTop;
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (text: string) => host.document.querySelectorAll("button").find((b) => b.textContent === text)!;
const panel = () => container.querySelector('[id="publish-popover"]');
const question = () => host.document.querySelector("[data-unpublish-question]");
const fire = (target: HostElement | ReturnType<typeof installDomHost>["document"], type: string, extra: Record<string, unknown> = {}) =>
  act(async () => { target.dispatchEvent(Object.assign(new HostEvent(type, { bubbles: true, cancelable: true }), extra)); });

async function ask() {
  await act(async () => root.render(<PublishControl map={map} onChange={changed} />));
  await act(async () => button("Published").click());
  await settle();
  button("Unpublish").focus();
  await act(async () => button("Unpublish").click());
}

it("asks in the documented words and sends nothing until answered", async () => {
  await ask();
  expect(question()?.getAttribute("role")).toBe("dialog");
  expect(question()?.textContent).toBe(
    "Unpublish Station catchments?The link and every embed stop working. If you publish again, the map gets a new link.CancelUnpublish map",
  );
  expect(button("Unpublish map").getAttribute("data-variant")).toBe("danger");
  expect(deletes).toHaveLength(0);
  expect(panel()).not.toBeNull();
});

it("keeps the panel open under the question: Cancel, a press on the question and Escape answer the question alone", async () => {
  await ask();
  await act(async () => button("Cancel").click());
  expect(question()).toBeNull();
  expect(panel()).not.toBeNull();
  expect(host.document.activeElement).toBe(button("Unpublish"));

  await act(async () => button("Unpublish").click());
  await fire(button("Cancel"), "pointerdown");
  expect(panel()).not.toBeNull();
  expect(question()).not.toBeNull();

  await fire(host.document, "keydown", { key: "Escape" });
  expect(question()).toBeNull();
  expect(panel()).not.toBeNull();
  expect(deletes).toHaveLength(0);
  expect(changed).not.toHaveBeenCalled();

  // The hold is the question's alone: with it gone, Escape closes the panel.
  await fire(host.document, "keydown", { key: "Escape" });
  expect(panel()).toBeNull();
});

it("unpublishes once on Unpublish map, then follows the server's answer", async () => {
  await ask();
  await act(async () => button("Unpublish map").click());
  await act(async () => button("Unpublish map").click());
  expect(deletes).toHaveLength(1);
  expect(button("Cancel").disabled).toBe(true);
  await fire(host.document, "keydown", { key: "Escape" });
  expect(question()).not.toBeNull();
  await act(async () => { deletes[0].resolve(new Response(null, { status: 204 })); });
  await settle();
  expect(question()).toBeNull();
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps a refusal or a lost connection in the question, and the map shown published", async () => {
  await ask();
  await act(async () => button("Unpublish map").click());
  await act(async () => { deletes[0].resolve(Response.json({ error: { code: "stale_revision", message: "This map changed since you opened it." } }, { status: 409 })); });
  await settle();
  expect(question()?.textContent).toContain("This map changed since you opened it.");
  expect(changed).not.toHaveBeenCalled();
  expect(button("Unpublish map").disabled).toBe(false);
  expect(button("Published")).toBeDefined();

  await act(async () => button("Unpublish map").click());
  await act(async () => { deletes[1].reject(new TypeError("Failed to fetch")); });
  await settle();
  expect(question()?.textContent).toContain("Couldn't unpublish the map. Is the server reachable?");
  expect(changed).not.toHaveBeenCalled();
  expect(panel()).not.toBeNull();
});
