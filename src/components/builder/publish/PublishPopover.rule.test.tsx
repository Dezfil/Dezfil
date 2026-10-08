import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import { PublishPopover } from "./PublishPopover";

/**
 * The publish popover under who may publish. While the rule holds the
 * person back, Publish map is drawn disabled with the rule's one
 * sentence, and on a live publication its reader controls and shared
 * fields are disabled beside the same sentence; the link, its copy, the
 * embed and Unpublish stay. A map not yet published keeps its fields to
 * arrange. With no rule holding them back, or no rule read, the popover
 * draws as it always has. The runtime read, the account and the map's
 * reads are fakes.
 */
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));

const ADMINS_ONLY = "Only admins can publish maps on this instance.";
const NO_ONE = "No one can publish maps on this instance.";

const map = (published: boolean): MapWithLayers =>
  ({ id: "m", name: "Station catchments", layers: [], updatedAt: "2026-10-08T00:00:00Z",
    publishToken: published ? "token-owner" : null, publishedAt: published ? "2026-10-01T00:00:00Z" : null, published }) as unknown as MapWithLayers;

let rule: string | null;
let admin: boolean;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  rule = "everyone";
  admin = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") {
      return rule === null ? Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })
        : Response.json({ rules: { "publishing.publish": rule } });
    }
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: admin } });
    if (url === "/api/maps/m/published-fields") {
      return Response.json({ layers: [{ layerId: "l1", name: "Stations", mode: "list", list: ["name"],
        fields: [{ name: "name", required: false }], available: ["name", "kind"] }] });
    }
    if (url === "/api/maps/m/publish") {
      return Response.json({ token: "token-owner", publishedAt: "2026-10-01T00:00:00Z", theme: "light",
        viewerControls: { tilt: true, fit: true, theme: true, basemap: true, coords: false } });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  // The link is drawn from the page's own address.
  Object.assign(host.window, { location: { origin: "https://maps.example.test" } });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open(published: boolean) {
  await act(async () => root.render(<PublishPopover map={map(published)} onChange={() => {}} />));
  await settle();
}
const button = (text: string) => container.querySelectorAll("button").find(element => element.textContent === text);
const checkbox = (text: string) => container.querySelectorAll("label").find(element => element.textContent === text)?.querySelector("input");
/** Opens the shared-fields row and its one layer's editor. */
async function editFields(heading: string) {
  await act(async () => container.querySelectorAll("button").find(element => element.textContent?.startsWith(heading))!.click());
  await settle();
  await act(async () => button("Edit")!.click());
}
const sentences = () => [ADMINS_ONLY, NO_ONE].filter(sentence => container.textContent.includes(sentence));

describe("who may publish, in the publish popover", () => {
  for (const [value, who, sentence] of [["admins", "a member", ADMINS_ONLY], ["none", "an admin", NO_ONE]] as const) {
    it(`draws Publish map disabled for ${who} under ${value}, with the rule's sentence, and keeps the fields to arrange`, async () => {
      rule = value;
      admin = who === "an admin";
      await open(false);
      expect(button("Publish map")!.disabled).toBe(true);
      expect(sentences()).toEqual([sentence]);
      await editFields("Fields this will share");
      expect(checkbox("kind")!.disabled).toBe(false);
      expect(button("Reset to automatic")!.disabled).toBe(false);
    });

    it(`holds a live publication's controls and fields for ${who} under ${value} and keeps its link, embed and Unpublish`, async () => {
      rule = value;
      admin = who === "an admin";
      await open(true);
      expect(sentences()).toEqual([sentence]);
      for (const mode of ["Light", "Dark"]) expect(button(mode)!.disabled, mode).toBe(true);
      for (const control of ["3D tilt", "Fit to data", "Light / dark", "Basemap picker", "Cursor coordinates"]) {
        expect(checkbox(control)!.disabled, control).toBe(true);
      }
      for (const kept of ["Copy link", "Embed", "Unpublish"]) expect(button(kept)!.disabled, kept).toBe(false);
      expect(container.textContent).toContain("/v/token-owner");
      await editFields("Shared fields");
      expect(checkbox("kind")!.disabled).toBe(true);
      expect(checkbox("name")!.disabled).toBe(true);
      expect(button("Reset to automatic")!.disabled).toBe(true);
    });
  }

  for (const [value, who] of [["everyone", "a member"], ["admins", "an admin"], [null, "a member, the rule unread,"]] as const) {
    it(`draws as it always has for ${who} under ${value ?? "no rule"}`, async () => {
      rule = value;
      admin = who === "an admin";
      await open(false);
      expect(button("Publish map")!.disabled).toBe(false);
      expect(sentences()).toEqual([]);
      act(() => root.unmount());
      root = createRoot(container as unknown as Element);
      await open(true);
      expect(sentences()).toEqual([]);
      for (const mode of ["Light", "Dark"]) expect(button(mode)!.disabled, mode).toBe(false);
      expect(checkbox("3D tilt")!.disabled).toBe(false);
      await editFields("Shared fields");
      expect(checkbox("kind")!.disabled).toBe(false);
      expect(button("Reset to automatic")!.disabled).toBe(false);
    });
  }
});
