import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SketchGeometry } from "@/lib/sketch/geometry";
import type { CameraHandle } from "../../map/camera-handle";
import { cssRules } from "../../testing/css-rules";
import { HostElement, installDomHost } from "../../testing/dom-host";
import { circleRing, rectangleRing } from "./draft-geometry";
import { DrawOverlay } from "./DrawOverlay";
import type { Ground } from "./selection-mark";

/**
 * A selected drawn shape stands out from the unselected ones: every kind
 * the selection supports draws one mark, a thicker accent outline over a
 * soft accent glow (a wider, low-opacity accent stroke beneath it), with a
 * thin casing in the panel colour between them that keeps the outline
 * readable over a basemap of either tone. Solid, unlike a draft's dashed
 * line, and inked from the theme's tokens, so the light and the dark
 * theme each draw it in their own accent. The camera is a stand-in that
 * projects ground straight to pixels.
 */

const SHEET = "src/components/builder/draw/draw.module.css";
const body = (selector: string) =>
  cssRules(SHEET).filter((r) => r.selector === selector).map((r) => r.body).join(";");
const prop = (selector: string, name: string) =>
  new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+);`).exec(body(selector))?.[1].trim() ?? null;

const TRIANGLE: Ground[] = [[13.38, 52.52], [13.42, 52.52], [13.4, 52.5], [13.38, 52.52]];
const CASES: [string, SketchGeometry][] = [
  ["polygon", { type: "Polygon", coordinates: [TRIANGLE] }],
  ["freehand", { type: "Polygon", coordinates: [TRIANGLE] }],
  ["rectangle", { type: "Polygon", coordinates: [rectangleRing([13.38, 52.5], [13.42, 52.52])] }],
  ["circle", { type: "Polygon", coordinates: [circleRing([13.4, 52.51], 1)] }],
  ["line", { type: "LineString", coordinates: [[13.3, 52.5], [13.35, 52.51], [13.4, 52.5]] }],
  ["point", { type: "Point", coordinates: [13.405, 52.52] }],
];

const camera = {
  project: ([lng, lat]: [number, number]) => ({ x: (lng - 13) * 1000, y: (53 - lat) * 1000 }),
  unproject: ({ x, y }: { x: number; y: number }) => [13 + x / 1000, 53 - y / 1000],
  onCameraMove: () => () => {},
} as unknown as CameraHandle;

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let restoreRect: () => void;
beforeEach(() => {
  host = installDomHost();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const had = Object.getOwnPropertyDescriptor(HostElement.prototype, "getBoundingClientRect");
  Object.defineProperty(HostElement.prototype, "getBoundingClientRect", {
    configurable: true, value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
  });
  restoreRect = () => {
    if (had) Object.defineProperty(HostElement.prototype, "getBoundingClientRect", had);
    else delete (HostElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
  };
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  restoreRect();
  vi.unstubAllGlobals();
});

async function select(kind: string, geometry: SketchGeometry) {
  await act(async () => root.render(
    <DrawOverlay
      camera={camera}
      commit={async () => {}}
      selectedGeometry={{ selection: { layerId: "L", table: "sketches", featureId: "f1", kind }, geometry }}
      onMoveVertex={async () => {}}
    />,
  ));
}

describe("the selected shape's mark", () => {
  it.each(CASES)("stands out on a selected %s: glow, casing, then the outline, one shape traced three times", async (kind, geometry) => {
    await select(kind, geometry);
    const marks = container.querySelectorAll("[data-selection-mark]");
    expect(marks).toHaveLength(1);
    const layers = marks[0].children;
    expect(layers.map((l) => /_(select\w+)_/.exec(l.className)?.[1])).toEqual(["selectGlow", "selectCasing", "selectLine"]);
    const tag = kind === "point" ? "CIRCLE" : "PATH";
    expect(layers.map((l) => l.tagName.toUpperCase())).toEqual([tag, tag, tag]);
    const shape = (l: HostElement) => (tag === "PATH" ? [l.getAttribute("d")] : ["cx", "cy", "r"].map((a) => l.getAttribute(a)));
    expect(shape(layers[1])).toEqual(shape(layers[0]));
    expect(shape(layers[2])).toEqual(shape(layers[0]));
    // The draft's dashed line is not the selection's.
    expect(container.querySelectorAll("path").filter((p) => /_draftLine_/.test(p.className))).toHaveLength(0);
    expect(container.querySelectorAll("circle").filter((c) => /_draftLine_/.test(c.className))).toHaveLength(0);
  });

  it("draws the outline thicker than a draft's line, solid, in the theme's accent", () => {
    expect(prop(".selectLine", "stroke")).toBe("var(--accent)");
    expect(parseFloat(prop(".selectLine", "stroke-width")!)).toBeGreaterThan(parseFloat(prop(".draftLine", "stroke-width")!));
    expect(prop(".selectLine", "stroke-dasharray")).toBeNull();
  });

  it("lays a soft accent glow under it: wider and faint", () => {
    expect(prop(".selectGlow", "stroke")).toBe("var(--accent)");
    expect(parseFloat(prop(".selectGlow", "stroke-width")!)).toBeGreaterThan(parseFloat(prop(".selectCasing", "stroke-width")!));
    const opacity = parseFloat(prop(".selectGlow", "stroke-opacity")!);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(0.5);
  });

  it("edges the outline with a thin casing in the panel colour, and fills nothing", () => {
    expect(prop(".selectCasing", "stroke")).toBe("var(--bg-panel)");
    expect(parseFloat(prop(".selectCasing", "stroke-width")!)).toBeGreaterThan(parseFloat(prop(".selectLine", "stroke-width")!));
    expect(prop(".selectLine", "fill")).toBe("none");
    for (const selector of [".selectGlow", ".selectCasing", ".selectLine"]) {
      expect(body(selector), selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
  });
});
