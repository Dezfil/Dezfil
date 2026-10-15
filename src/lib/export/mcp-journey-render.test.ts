import { afterEach, expect, it, vi } from "vitest";
import { renderJourney } from "../../../scripts/mcp-journey-render.mjs";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { pinMarksForSpace } from "./pin-marks";
import { encodePng } from "./png-codec";

vi.mock("../../../scripts/loopback-basemap.mjs", () => ({
  startLoopbackBasemap: async () => ({ styleUrl: "http://fixture.test/style.json", snapshot: () => ({}), delta: () => ({}), close: async () => {} }),
  assertBasemapTraffic: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

async function journey(blank = false) {
  let style: LayerStyle = defaultStyle("POINT");
  const gate = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "create_layer") style = args.style as LayerStyle ?? style;
    if (name === "export_map_image") {
      // A synthetic filled disk exercises the script's measurement and seed,
      // not the browser. Exported marks keep their share of the output width.
      const width = 480, height = 320;
      const radius = pinMarksForSpace([{ style }], width)[0].style.pointRadius;
      const rgba = new Uint8Array(width * height * 4).fill(240);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const inside = !blank && Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) < radius;
        rgba.set(inside ? [26, 93, 74, 255] : [240, 240, 240, 255], (y * width + x) * 4);
      }
      return { attachment: { content_base64: Buffer.from(encodePng({ width, height, rgba })).toString("base64") } };
    }
    return { id: "map", name: "points", editRevision: "revision" };
  });
  try { await renderJourney({ call, gate }); }
  finally { expect(gate.mock.calls.map(([name]) => name)).toEqual(["delete_map", "delete_table"]); }
}

it("accepts the synthetic pixels of the point the journey actually seeds", async () => {
  await expect(journey()).resolves.toBeUndefined();
});

it("rejects an empty image even when the transport and dimensions succeed", async () => {
  await expect(journey(true)).rejects.toThrow("no data pixels");
});
