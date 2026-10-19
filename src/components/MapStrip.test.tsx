import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { HostEvent, installDomHost, type HostElement } from "./testing/dom-host";
import { MapStrip } from "./MapStrip";

/**
 * A map's card picture is asked for by the listing's picture version, and
 * only when the listing says the reader is served one: a map with none
 * draws the chart-paper placeholder and sends no request, so no answer can
 * fail. While newer work waits or has failed, the last picture stays; a
 * picture that fails to load leaves the placeholder; a toggle of the theme
 * asks for the same version in the other theme, and a map's edit that
 * leaves the version alone asks for nothing new.
 */

vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: () => <i data-placeholder="" /> }));
const look = vi.hoisted(() => ({ theme: "light" as "light" | "dark" }));
vi.mock("./theme", () => ({ useTheme: () => ({ theme: look.theme }) }));

const AT = "2026-10-02T14:00:00Z";
type Picture = Pick<MapOverview, "pictureState" | "pictureVersion" | "hasThumbnail"> & { updatedAt?: string };
const map = (picture: Picture) => ({ id: "m", name: "Depot", updatedAt: AT, ...picture }) as unknown as MapOverview;
const address = (version: string, theme = "light") => `/api/maps/m/thumbnail?v=${encodeURIComponent(version)}&theme=${theme}`;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  look.theme = "light";
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

async function draw(picture: Picture) {
  await act(async () => root.render(<MapStrip map={map(picture)} />));
}
const placeholders = () => container.querySelectorAll("[data-placeholder]");
const requested = () => container.querySelectorAll("img").map((img) => img.getAttribute("src"));

describe("a map's card picture", () => {
  it.each([
    ["waiting for its first picture", { pictureState: "waiting", pictureVersion: null, hasThumbnail: false }],
    ["whose last attempt failed with no picture before it", { pictureState: "failed", pictureVersion: null, hasThumbnail: false }],
    ["the renderer cannot draw yet", { pictureState: "unsupported", pictureVersion: null, hasThumbnail: false }],
    ["on an instance with no renderer", { pictureState: "unavailable", pictureVersion: null, hasThumbnail: false }],
    ["whose picture the reader is not served", { pictureState: "current", pictureVersion: null, hasThumbnail: false }],
  ] as const)("with none, %s, draws only the placeholder and asks for nothing", async (_, picture) => {
    await draw(picture);
    expect(placeholders()).toHaveLength(1);
    expect(requested()).toEqual([]);
  });

  it.each([
    ["current", "current"],
    ["while newer work waits", "waiting"],
    ["while newer work has failed", "failed"],
    ["while the renderer cannot draw a newer state", "unsupported"],
    ["while the instance has no renderer", "unavailable"],
  ] as const)("served one, shows it %s, by its version, over the placeholder", async (_, pictureState) => {
    await draw({ pictureState, pictureVersion: "server-3", hasThumbnail: true });
    expect(placeholders()).toHaveLength(1);
    expect(requested()).toEqual([address("server-3")]);
  });

  it("asks for a new picture's address as soon as the listing names a new version, and for none on an edit that keeps it", async () => {
    await draw({ pictureState: "waiting", pictureVersion: "server-3", hasThumbnail: true });
    await draw({ pictureState: "waiting", pictureVersion: "server-3", hasThumbnail: true, updatedAt: "2026-10-02T15:00:00Z" });
    expect(requested()).toEqual([address("server-3")]);
    await draw({ pictureState: "current", pictureVersion: "server-4", hasThumbnail: true });
    expect(requested()).toEqual([address("server-4")]);
  });

  it("leaves the placeholder when the picture fails to load, and asks again for a new version", async () => {
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    await act(async () => { container.querySelector("img")!.dispatchEvent(new HostEvent("error")); });
    expect(requested()).toEqual([]);
    expect(placeholders()).toHaveLength(1);
    await draw({ pictureState: "current", pictureVersion: "server-4", hasThumbnail: true });
    expect(requested()).toEqual([address("server-4")]);
  });

  it("follows a theme toggle with the same version, and a failure in one theme strands nothing in the other", async () => {
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    look.theme = "dark";
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(requested()).toEqual([address("server-3", "dark")]);
    await act(async () => { container.querySelector("img")!.dispatchEvent(new HostEvent("error")); });
    expect(requested()).toEqual([]);
    look.theme = "light";
    await draw({ pictureState: "current", pictureVersion: "server-3", hasThumbnail: true });
    expect(requested()).toEqual([address("server-3")]);
  });
});
