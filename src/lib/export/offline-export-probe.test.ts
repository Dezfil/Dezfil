import { afterEach, expect, it, vi } from "vitest";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { pinMarksForSpace } from "./pin-marks";
import { encodePng } from "./png-codec";

vi.mock("../../../scripts/journey-auth.mjs", () => ({
  provisionJourney: async () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function probe(mode = "", blank = false) {
  vi.resetModules();
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "offline-export-probe.mjs", ...(mode ? [mode] : [])]);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => { throw Error(`exit ${code}`); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  let style = defaultStyle("POINT");
  let tiledChecks = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const pathname = new URL(input).pathname;
    if (pathname === "/api/health") return Response.json({ ok: true });
    if (pathname === "/api/tables") return Response.json({ name: "points" });
    if (pathname === "/api/maps") return Response.json({ id: "map", editRevision: "revision" });
    if (pathname === "/api/maps/map/layers") {
      const body = JSON.parse(init!.body as string);
      style = body.style as LayerStyle ?? style;
      return Response.json({ id: "layer" });
    }
    if (pathname === "/api/layers/layer/render") {
      tiledChecks++;
      return Response.json({ mode: "tiled", tiles: { state: "ready" } });
    }
    if (pathname === "/api/maps/map/export/image") {
      if (mode === "--expect-unavailable") return Response.json({ error: { code: "render_unavailable" } }, { status: 503 });
      // Synthetic output tests the script's seed and pixel assertion only.
      const width = 640, height = 360;
      const radius = pinMarksForSpace([{ style }], width)[0].style.pointRadius;
      const centres = mode === "--tiled" ? Array.from({ length: 40 }, (_, i) => [40 + i % 10 * 60, 60 + Math.floor(i / 10) * 60])
        : [[160, 120], [480, 120], [160, 240], [480, 240]];
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const inside = !blank && centres.some(([cx, cy]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < radius);
        rgba.set(inside ? [26, 93, 74, 255] : [240, 240, 240, 255], (y * width + x) * 4);
      }
      return new Response(new Uint8Array(encodePng({ width, height, rgba })));
    }
    throw Error(`Unexpected request: ${pathname}`);
  }));
  try {
    await import("../../../scripts/offline-export-probe.mjs");
    expect(exit).not.toHaveBeenCalled();
    expect(tiledChecks).toBe(mode === "--tiled" ? 1 : 0);
  } catch (failure) {
    if (mode === "--expect-unavailable") {
      expect(exit).toHaveBeenCalledWith(0);
      expect(error).not.toHaveBeenCalled();
      return;
    }
    if (blank) expect(error).toHaveBeenCalledWith(expect.stringContaining("no data pixels"));
    throw failure;
  }
}

it("plain mode accepts the synthetic pixels of the four points it seeds", async () => {
  await expect(probe()).resolves.toBeUndefined();
});
it("plain mode rejects an empty image", async () => {
  await expect(probe("", true)).rejects.toThrow("exit 1");
});
it("tiled mode still checks ready tiles and data pixels", async () => {
  await expect(probe("--tiled")).resolves.toBeUndefined();
});
it("the unavailable mode still requires the coded error and healthy instance", async () => {
  await expect(probe("--expect-unavailable")).resolves.toBeUndefined();
});
