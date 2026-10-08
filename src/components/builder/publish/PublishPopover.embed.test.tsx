import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import { PublishPopover } from "./PublishPopover";

/**
 * The publish popover's Embed view under the instance's embedding rule:
 * offered under Any site as it always was, offered under Listed sites
 * with one sentence that only the listed sites show it, and not offered
 * under Off, where the link, its copy and Unpublish stay. With no rule
 * read, the view is offered as it always was. The runtime read, the
 * account and the map's reads are fakes.
 */
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));

const LISTED = "Only the sites an admin has listed show it.";

const published: MapWithLayers = ({ id: "m", name: "Station catchments", layers: [], updatedAt: "2026-10-08T00:00:00Z",
  publishToken: "token-owner", publishedAt: "2026-10-01T00:00:00Z", published: true }) as unknown as MapWithLayers;

let embedding: string | null;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  embedding = "any";
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") {
      return embedding === null ? Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })
        : Response.json({ rules: { "publishing.publish": "everyone", "publishing.embedding": embedding } });
    }
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: false } });
    if (url === "/api/maps/m/published-fields") return Response.json({ layers: [] });
    if (url === "/api/maps/m/publish") {
      return Response.json({ token: "token-owner", publishedAt: "2026-10-01T00:00:00Z", theme: "light",
        viewerControls: { tilt: true, fit: true, theme: true, basemap: true, coords: false } });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
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
async function open() {
  await act(async () => root.render(<PublishPopover map={published} onChange={() => {}} />));
  await settle();
}
const button = (text: string) => container.querySelectorAll("button").find(element => element.textContent === text);
async function openEmbed() {
  await act(async () => button("Embed")!.click());
  await settle();
}

describe("the Embed view under the embedding rule", () => {
  it("is offered under Any site with no sentence", async () => {
    await open();
    await openEmbed();
    expect(container.textContent).toContain("Embed this map");
    expect(container.querySelector('textarea[aria-label="Embed code"]')).not.toBeNull();
    expect(container.textContent).not.toContain(LISTED);
  });

  it("is offered under Listed sites with its one sentence", async () => {
    embedding = "listed";
    await open();
    expect(container.textContent).not.toContain(LISTED);
    await openEmbed();
    expect(container.textContent).toContain("Embed this map");
    expect(container.querySelector('textarea[aria-label="Embed code"]')).not.toBeNull();
    expect(container.textContent.split(LISTED).length - 1).toBe(1);
  });

  it("is not offered under Off, the link and Unpublish kept", async () => {
    embedding = "off";
    await open();
    expect(button("Embed")).toBeUndefined();
    for (const kept of ["Copy link", "Unpublish"]) expect(button(kept)?.disabled, kept).toBe(false);
    expect(container.textContent).toContain("/v/token-owner");
    expect(container.textContent).not.toContain(LISTED);
  });

  it("is offered as it always was when the rule could not be read", async () => {
    embedding = null;
    await open();
    await openEmbed();
    expect(container.textContent).toContain("Embed this map");
    expect(container.textContent).not.toContain(LISTED);
  });
});
