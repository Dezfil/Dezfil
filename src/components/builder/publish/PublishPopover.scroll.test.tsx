import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { cssRules } from "../../testing/css-rules";
import { HostElement, HostEvent, installDomHost } from "../../testing/dom-host";
import { PublishControl, panelMaxHeight } from "./PublishControl";

/**
 * The publish panel in a window too short for it: it ends above the
 * window's bottom edge, its head (the status, the link and its copy, or
 * the Publish button) stays put, and everything under the head scrolls
 * inside it: a long field list, the reader's controls and Unpublish, or
 * the whole embed view. The test host computes no layout, so the panel's
 * place is a stand-in and the scrolling is read from the stylesheets.
 */
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));

const POPOVER = "src/components/builder/publish/PublishPopover.module.css";
const CONTROL = "src/components/builder/publish/PublishControl.module.css";
const rule = (file: string, selector: string) =>
  cssRules(file).filter((r) => r.selector === selector).map((r) => r.body).join(";");

const map = (published: boolean): MapWithLayers => ({
  id: "m", name: "Station catchments", layers: [], updatedAt: "2026-10-08T00:00:00Z",
  publishToken: published ? "token-owner" : null, publishedAt: published ? "2026-10-01T00:00:00Z" : null, published,
}) as unknown as MapWithLayers;
const fields = Array.from({ length: 36 }, (_, i) => ({ name: `field_${i}`, required: false }));

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
const restore: (() => void)[] = [];

/** The panel's anchor sits this far down the window, the panel this far under it. */
function placeAt(wrapTop: number, popOffset: number) {
  const rect = Object.getOwnPropertyDescriptor(HostElement.prototype, "getBoundingClientRect");
  const offset = Object.getOwnPropertyDescriptor(HostElement.prototype, "offsetTop");
  Object.defineProperty(HostElement.prototype, "getBoundingClientRect", {
    configurable: true, value: () => ({ top: wrapTop, bottom: wrapTop + 36, left: 0, right: 0, width: 0, height: 36 }),
  });
  Object.defineProperty(HostElement.prototype, "offsetTop", { configurable: true, get: () => popOffset });
  restore.push(() => {
    if (rect) Object.defineProperty(HostElement.prototype, "getBoundingClientRect", rect);
    else delete (HostElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
    if (offset) Object.defineProperty(HostElement.prototype, "offsetTop", offset);
    else delete (HostElement.prototype as unknown as Record<string, unknown>).offsetTop;
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") return Response.json({ rules: { "publishing.publish": "everyone", "publishing.embedding": "any" } });
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: false } });
    if (url === "/api/maps/m/published-fields") {
      return Response.json({ layers: [{ layerId: "L", name: "Stations", mode: "derived", fields, available: fields.map((f) => f.name), list: null }] });
    }
    if (url === "/api/maps/m/publish") {
      return Response.json({ token: "token-owner", publishedAt: "2026-10-01T00:00:00Z", theme: "light",
        viewerControls: { tilt: true, fit: true, theme: true, basemap: true, coords: false } });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  Object.assign(host.window, { location: { origin: "https://maps.example.test" }, innerHeight: 520 });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  placeAt(14, 44);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  restore.splice(0).forEach((undo) => undo());
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (text: string) => container.querySelectorAll("button").find((b) => b.textContent === text);
async function open(published: boolean) {
  await act(async () => root.render(<PublishControl map={map(published)} onChange={() => {}} />));
  await act(async () => button(published ? "Published" : "Publish")!.click());
  await settle();
  return container.querySelector('[id="publish-popover"]')!;
}
const head = (pop: HostElement) => pop.querySelectorAll("div").find((d) => /(^|\s)_head_/.test(d.className))!;
const scroller = (pop: HostElement) => pop.querySelector("[data-publish-scroll]")!;

describe("the publish panel's bound", () => {
  it("runs from where the panel starts to the window's bottom edge, less a margin", () => {
    expect(panelMaxHeight(58, 520)).toBe(450);
    expect(panelMaxHeight(58, 900)).toBe(830);
    expect(panelMaxHeight(58, 40)).toBe(0);
  });

  it("is set on the open panel and follows the window's height", async () => {
    const pop = await open(true);
    expect(pop.style.maxHeight).toBe(`${panelMaxHeight(14 + 44, 520)}px`);
    Object.assign(host.window, { innerHeight: 400 });
    await act(async () => { host.window.dispatchEvent(new HostEvent("resize")); });
    expect(pop.style.maxHeight).toBe(`${panelMaxHeight(14 + 44, 400)}px`);
  });

  it("is a column whose content shrinks to it, the head fixed and the rest scrolling", () => {
    expect(rule(CONTROL, ".pop")).toMatch(/display: flex;[\s\S]*flex-direction: column;/);
    expect(rule(POPOVER, ".body")).toMatch(/min-height: 0;/);
    expect(rule(POPOVER, ".head")).toMatch(/flex: none;/);
    for (const selector of [".scroll", ".embed"]) {
      expect(rule(POPOVER, selector), selector).toMatch(/min-height: 0;/);
      expect(rule(POPOVER, selector), selector).toMatch(/overflow-y: auto;/);
    }
  });
});

describe("what stays and what scrolls", () => {
  it("keeps a published map's status, link and Copy link in the head, and scrolls its fields, controls and Unpublish", async () => {
    const pop = await open(true);
    const top = head(pop);
    expect(top.textContent).toContain("Published");
    expect(top.querySelector("[data-publish-url]")?.textContent).toBe("maps.example.test/v/token-owner");
    expect(top.querySelectorAll("button").map((b) => b.textContent)).toEqual(["Copy link"]);
    const rest = scroller(pop);
    await act(async () => rest.querySelectorAll("button").find((b) => b.textContent?.startsWith("Shared fields"))!.click());
    await act(async () => rest.querySelectorAll("button").find((b) => b.textContent === "Edit")!.click());
    expect(rest.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThanOrEqual(fields.length);
    expect(rest.textContent).toContain("Readers can");
    expect(rest.querySelectorAll("button").map((b) => b.textContent)).toContain("Unpublish");
    expect(top.textContent).not.toContain("field_0");
  });

  it("keeps a draft's Publish map in the head and scrolls the fields it will share", async () => {
    const pop = await open(false);
    expect(head(pop).querySelectorAll("button").map((b) => b.textContent)).toEqual(["Publish map"]);
    expect(scroller(pop).textContent).toContain("Fields this will share");
  });

  it("scrolls the embed view whole, its Back still taking focus", async () => {
    const pop = await open(true);
    await act(async () => button("Embed")!.click());
    await settle();
    const embed = pop.children[0];
    expect(embed.className).toMatch(/(^|\s)_embed_/);
    expect(embed.querySelector('textarea[aria-label="Embed code"]')).not.toBeNull();
    expect(host.document.activeElement?.textContent).toBe("Back");
  });
});
