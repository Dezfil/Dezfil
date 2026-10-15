import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapOverview } from "./api";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { MapStrip } from "./MapStrip";

/**
 * A map's picture asks for the card image only when the listing says the
 * map has one the reader is served: a map never captured draws the
 * chart-paper placeholder and sends no request, so no answer can fail.
 */

vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: () => <i data-placeholder="" /> }));

const AT = "2026-10-02T14:00:00Z";
const map = (hasThumbnail: boolean) => ({ id: "m", name: "Depot", updatedAt: AT, hasThumbnail }) as unknown as MapOverview;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

it.each([
  ["no picture", false, []],
  ["a picture", true, [`/api/maps/m/thumbnail?v=${encodeURIComponent(AT)}&theme=light`]],
])("a map with %s draws the placeholder and asks for exactly its picture", async (_, hasThumbnail, requested) => {
  await act(async () => root.render(<MapStrip map={map(hasThumbnail as boolean)} />));
  expect(container.querySelectorAll("[data-placeholder]")).toHaveLength(1);
  expect(container.querySelectorAll("img").map((img) => img.getAttribute("src"))).toEqual(requested);
});
