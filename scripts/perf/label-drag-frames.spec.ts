/**
 * Label-rebuild profiling harness in a real browser, with a real GPU.
 *
 * Measurement only. It creates its own tables, maps and layers through the
 * documented API, drives the real style slider, and prints numbers; it
 * asserts almost nothing, because a measurement that fails a threshold is
 * still a measurement.
 *
 * It lives outside `e2e/` and has its own config, so `npx playwright test`
 * never picks it up. Re-run against a production standalone instance on a
 * fresh data directory (never port 3000):
 *
 *   DEZFIL_BASE_URL=http://127.0.0.1:3141 \
 *     npx playwright test --config scripts/perf/playwright.perf.config.ts
 *
 * What it measures. A style-slider drag writes an appearance draft per input
 * event; `MapBuilder`'s `renderedLayers` memo therefore produces a new array,
 * and `MapCanvas` re-runs `buildDeckLayers` for every layer. A labelled layer
 * re-derives its text data there (`labelableFeatures`) — a fresh array
 * identity, which is what makes deck.gl invalidate and re-upload the
 * TextLayer's attributes. Heat/OD/icon/cluster layers keep an identity cache
 * and the base GeoJsonLayer passes `l.geojson` straight through, so the
 * labelled layer is the only one paying per tick.
 *
 * The drag is driven from inside the page at requestAnimationFrame cadence,
 * dispatching the same `input` event a pointer drag produces (through the
 * native value setter, so React sees it) and never releasing — so no commit
 * round-trip pollutes the sample. Two numbers come out per scenario:
 *
 *  - per-tick synchronous main-thread cost: the wall time of dispatching one
 *    input event, which carries React's synchronous re-render, the label
 *    rebuild, and deck's `setProps`;
 *  - frame intervals during the sustained drag, with a long-frame count —
 *    the smoothness the per-tick rebuild cost predicts.
 *
 * Labelled and unlabelled layers over identical data are the two arms.
 */
import { test, expect } from "@playwright/test";
import {
  addLayer,
  createMap,
  patchLayer,
  readLayer,
  seedCsv,
} from "../../e2e/support";

/** Feature counts to sweep. */
const COUNTS = [10_000, 100_000];
/**
 * Slider changes per arm — ONE PER ANIMATION FRAME, so the arms compare
 * equal amounts of slider work, not equal wall-clock gesture time. On an
 * unblocked 120 Hz display 120 of them take about a second; when the main
 * thread stalls the same 120 take longer, and that ratio is the result.
 * It is deliberately NOT a claim about how long a human's one-second drag
 * becomes: a real pointer drag's event count depends on the device rate and
 * on the browser coalescing moves while the thread is stalled. Measuring
 * that would need a time-bounded gesture that counts the `input` events
 * which actually land.
 */
const TICKS = 120;

const LABEL = {
  attribute: "name",
  size: 12,
  color: { r: 240, g: 244, b: 248, a: 1 },
  haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
};

function csv(rows: number): string {
  const out = ["name,lon,lat,riders"];
  for (let i = 0; i < rows; i++) {
    out.push(
      `Station ${i},${(13.2 + ((i % 9973) * 1e-4)).toFixed(6)},${(
        52.4 +
        ((i % 9967) * 1e-4)
      ).toFixed(6)},${i % 4000}`,
    );
  }
  return out.join("\n");
}

interface DragResult {
  ticks: number;
  tickMs: { min: number; p25: number; median: number; p75: number; p95: number; max: number };
  frameMs: { min: number; p25: number; median: number; p75: number; p95: number; max: number };
  longFrames: number;
  dragMs: number;
}

function fmt(label: string, r: DragResult): string {
  const q = (o: DragResult["tickMs"]) =>
    `min ${o.min.toFixed(2)}  p25 ${o.p25.toFixed(2)}  median ${o.median.toFixed(
      2,
    )}  p75 ${o.p75.toFixed(2)}  p95 ${o.p95.toFixed(2)}  max ${o.max.toFixed(2)}`;
  return (
    `  ${label}\n` +
    `      per-tick sync cost (ms):  ${q(r.tickMs)}\n` +
    `      frame interval    (ms):  ${q(r.frameMs)}\n` +
    `      frames over 20 ms: ${r.longFrames}/${r.ticks}   drag wall time ${r.dragMs.toFixed(
      0,
    )} ms`
  );
}

test("labelled vs unlabelled slider drag", async ({ page }) => {
  test.setTimeout(900_000);
  const lines: string[] = [];

  // Record the GL renderer: headed Chromium is only a
  // NECESSARY condition for hardware GL, not proof of it — a SwiftShader
  // fallback would inflate both arms and make the absolute frame times
  // describe software rasterization instead of this machine's GPU. The
  // labelled/plain comparison survives either way; the magnitudes do not,
  // so the renderer belongs in the record.
  await page.goto("/maps");
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return "NO WEBGL CONTEXT";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const unmasked = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : "(WEBGL_debug_renderer_info unavailable)";
    return `${unmasked} | vendor ${String(gl.getParameter(gl.VENDOR))} | version ${String(
      gl.getParameter(gl.VERSION),
    )}`;
  });
  console.log(`\nGL renderer as seen by the page: ${renderer}\n`);

  for (const count of COUNTS) {
    await page.goto("/maps");
    const table = `perf_labels_${count}`;
    await seedCsv(page, table, csv(count));

    for (const labelled of [false, true]) {
      const mapId = await createMap(
        page,
        `label-drag ${count} ${labelled ? "labelled" : "plain"}`,
      );
      const layerId = await addLayer(
        page,
        mapId,
        table,
        `SELECT name, riders, geometry FROM ${table}`,
      );
      if (labelled) {
        // PATCH /api/layers/[id] replaces `style` wholesale and validates it
        // as a complete LayerStyle (src/lib/layer-service.ts,
        // deriveAndCommitUpdate) — it does not merge with the stored style.
        // Every real caller (StylePanel.tsx's `patch`, MapBuilder.tsx's
        // commitStyleAppearance) spreads the partial over the layer's
        // current style before sending it; a label-only body fails
        // validation ("stroke must be a color"). Mirror that merge here.
        const current = await readLayer<{ style: Record<string, unknown> }>(
          page,
          layerId,
        );
        await patchLayer(page, layerId, {
          style: { ...current.style, label: LABEL },
        });
      }

      await page.goto(`/maps/${mapId}`);
      const layerRow = page
        .getByRole("button", { name: new RegExp(table) })
        .first();
      await expect(layerRow).toBeVisible({ timeout: 120_000 });
      await layerRow.click();

      const slider = page.getByRole("slider", { name: "Layer opacity" });
      await expect(slider).toBeVisible({ timeout: 120_000 });
      // The render must have landed, or the drag measures an empty canvas.
      const rendered = await page.evaluate(async (id) => {
        const r = await fetch(`/api/layers/${id}/render`);
        const j = (await r.json()) as { featureCount?: number };
        return j.featureCount ?? 0;
      }, layerId);
      expect(rendered).toBe(count);
      // Let the first paint and the initial attribute upload settle.
      await page.waitForTimeout(4000);

      const result = (await page.evaluate(async (ticks) => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Layer opacity"]',
        );
        if (!input) throw new Error("opacity slider not found");
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        const tickMs: number[] = [];
        const frameMs: number[] = [];
        const t0 = performance.now();
        let last = t0;
        let i = 0;
        await new Promise<void>((resolve) => {
          const step = (now: number) => {
            frameMs.push(now - last);
            last = now;
            if (i >= ticks) {
              resolve();
              return;
            }
            // A drag never lands on the same value twice in a row; sweep
            // the full range so every tick is a genuine style change.
            const v = (0.05 + 0.95 * ((i % 40) / 40)).toFixed(2);
            const before = performance.now();
            setter.call(input, v);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            tickMs.push(performance.now() - before);
            i += 1;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        const dragMs = performance.now() - t0;
        const stats = (xs: number[]) => {
          const s = [...xs].sort((a, b) => a - b);
          const q = (p: number) => {
            const idx = (s.length - 1) * p;
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            return s[lo] + (s[hi] - s[lo]) * (idx - lo);
          };
          return {
            min: s[0],
            p25: q(0.25),
            median: q(0.5),
            p75: q(0.75),
            p95: q(0.95),
            max: s[s.length - 1],
          };
        };
        // The first frame interval is the gap since instrumentation started,
        // not a rendered frame — drop it.
        frameMs.shift();
        return {
          ticks: tickMs.length,
          tickMs: stats(tickMs),
          frameMs: stats(frameMs),
          longFrames: frameMs.filter((f) => f > 20).length,
          dragMs,
        };
      }, TICKS)) as DragResult;

      lines.push(
        fmt(
          `${count} features · ${labelled ? "LABELLED" : "plain"}`,
          result,
        ),
      );
      // Release the gesture so the page is left in a sane state.
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Layer opacity"]',
        );
        input?.dispatchEvent(new Event("blur", { bubbles: true }));
      });
      await page.waitForTimeout(1500);
    }
  }

  console.log(
    "\nsustained style-slider drag, labelled vs unlabelled\n" +
      lines.join("\n") +
      "\n",
  );
});
