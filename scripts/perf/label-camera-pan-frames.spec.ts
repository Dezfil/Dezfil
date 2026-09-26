/**
 * Deciding experiment — camera motion only, ZERO style changes.
 *
 * Measurement only, no product code touched. `label-drag-frames.spec.ts`
 * showed a labelled 100k layer stalling under a style-slider
 * drag (p75 66.7 ms, 58/120 long frames) while the unlabelled control
 * stayed smooth (8.4 ms, 0-1/120) — but a slider drag also re-derives the
 * label's text data every tick (`labelableFeatures`), so that harness
 * cannot tell "expensive per-tick JS work" apart from "expensive to just
 * draw ~1.29M glyph instances". This file isolates the second question:
 * drive the camera (pan) continuously over a STATIC labelled layer — no
 * style patch, no data change, no slider touch at all — and see whether
 * the same long-frame pattern appears.
 *
 * If it does: the label draw itself is the inherent cost (LOD/thinning is
 * the remedy, a product decision, not a bug). If camera-only frames stay
 * smooth while the slider arm still stalls, a per-tick invalidation
 * survives somewhere the slider triggers and panning does not.
 *
 * The camera is driven with real DOM mouse events on the MapLibre canvas
 * (`.maplibregl-canvas`), the same technique MapLibre's own drag-pan
 * handler expects from a real pointer drag: `mousedown` on the canvas
 * (bubbles to the canvas container, where the handler's initial listener
 * sits), then `mousemove` dispatched directly at `document` — MapLibre's
 * `HandlerManager` binds the drag-tracking `mousemove` listener on
 * `ownerDocument` with `{capture: true}` specifically so it keeps
 * receiving moves that leave the canvas mid-drag; a canvas-bubbled
 * `mousemove` reaches only the container's OWN `mousemove` listener,
 * which the mouse-pan handler never implements (only `mousemoveWindow`,
 * per `generateMousePanHandler`'s `assignEvents`) — so it silently does
 * nothing. `mouseup` goes back to the canvas (bubbles to the container,
 * where `mouseup` — assigned directly, unlike `mousemove` — IS wired).
 * See the in-loop comment by the dispatch calls for the full trace
 * (`node_modules/maplibre-gl/dist/maplibre-gl-dev.js`, `HandlerManager`'s
 * `_listeners` array). Position is computed by MapLibre via
 * `clientX`/`clientY` against the canvas's own bounding rect
 * (`DOM.mousePos(map.getCanvas(), e)`), so page-coordinate `clientX/Y`
 * values are all that is required — no reference to the `maplibregl.Map`
 * instance is needed or available (it is not exposed on `window`).
 *
 * An in-loop truth assertion (inside the same `page.evaluate` that runs
 * the timed loop, not a separate before/after check outside it) reads the
 * builder's status-bar BBox readout — driven by MapLibre's `move` event
 * regardless of input source — before and after the drive, and throws if
 * it did not change. A prior version of this harness had only an
 * outside-the-loop screenshot guard driven by `page.mouse` (a working,
 * different input path than the timed loop's own hand-dispatched events),
 * so it passed while the timed loop silently drove nothing — caught at
 * cross-model review. The lesson generalizes: a correctness guard must
 * exercise the exact code path it is meant to guard, not a working
 * substitute for it.
 *
 * Run against a production standalone (never dev, never port 3000):
 *
 *   DEZFIL_BASE_URL=http://127.0.0.1:3141 \
 *     npx playwright test --config scripts/perf/playwright.perf.config.ts \
 *     scripts/perf/label-camera-pan-frames.spec.ts
 */
import { test, expect } from "@playwright/test";
import { addLayer, createMap, patchLayer, readLayer, seedCsv } from "../../e2e/support";

const COUNT = 100_000;
/** Same tick budget as the slider harness, for a direct comparison. */
const TICKS = 120;

const LABEL = {
  attribute: "name",
  size: 12,
  color: { r: 240, g: 244, b: 248, a: 1 },
  haloWidth: 0,
  haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
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

interface PanResult {
  ticks: number;
  moveMs: { min: number; p25: number; median: number; p75: number; p95: number; max: number };
  frameMs: { min: number; p25: number; median: number; p75: number; p95: number; max: number };
  longFrames: number;
  dragMs: number;
}

function fmt(label: string, r: PanResult): string {
  const q = (o: PanResult["moveMs"]) =>
    `min ${o.min.toFixed(2)}  p25 ${o.p25.toFixed(2)}  median ${o.median.toFixed(
      2,
    )}  p75 ${o.p75.toFixed(2)}  p95 ${o.p95.toFixed(2)}  max ${o.max.toFixed(2)}`;
  return (
    `  ${label}\n` +
    `      per-tick sync cost (ms):  ${q(r.moveMs)}\n` +
    `      frame interval    (ms):  ${q(r.frameMs)}\n` +
    `      frames over 20 ms: ${r.longFrames}/${r.ticks}   pan wall time ${r.dragMs.toFixed(
      0,
    )} ms`
  );
}

test("camera pan only, labelled vs unlabelled, ZERO style changes", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const lines: string[] = [];

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

  const table = `perf_pan_${COUNT}`;
  await seedCsv(page, table, csv(COUNT));

  // The deciding conditions, predeclared: the
  // unlabelled control, today's always-draw, and the two candidate
  // modes through the REAL rendering path via the measurement seam in
  // text-sublayer (`__DEZFIL_LABEL_SPIKE__`). The seam is set before
  // each arm's page load and cleared after.
  // Since the verdict shipped automatic collision as the default, the
  // seam is inverted: no flag measures the SHIPPED mode; "always-draw"
  // disables collision (the counterfactual); "cap300" the fallback.
  const ARMS: { name: string; labelled: boolean; spike: string | null }[] = [
    { name: "plain (control)", labelled: false, spike: null },
    { name: "always-draw", labelled: true, spike: "always-draw" },
    { name: "collision (shipped)", labelled: true, spike: null },
    { name: "cap300", labelled: true, spike: "cap300" },
  ];
  // ONE initializer, installed once: multiple stacked init scripts have
  // UNDEFINED evaluation order (an earlier arm could overwrite a later
  // one's flag), so the flag rides localStorage, set
  // per arm before navigation, and every arm ASSERTS the page saw the
  // value it intended.
  await page.addInitScript(() => {
    const stored = window.localStorage.getItem("__DEZFIL_LABEL_SPIKE__");
    (window as { __DEZFIL_LABEL_SPIKE__?: unknown }).__DEZFIL_LABEL_SPIKE__ =
      stored ?? undefined;
  });
  for (const arm of ARMS) {
    const { labelled } = arm;
    await page.evaluate((spike) => {
      if (spike) window.localStorage.setItem("__DEZFIL_LABEL_SPIKE__", spike);
      else window.localStorage.removeItem("__DEZFIL_LABEL_SPIKE__");
    }, arm.spike);
    const mapId = await createMap(
      page,
      `pan ${COUNT} ${arm.name}`,
    );
    const layerId = await addLayer(
      page,
      mapId,
      table,
      `SELECT name, riders, geometry FROM ${table}`,
    );
    if (labelled) {
      const current = await readLayer<{ style: Record<string, unknown> }>(
        page,
        layerId,
      );
      await patchLayer(page, layerId, {
        style: { ...current.style, label: LABEL },
      });
    }

    await page.goto(`/maps/${mapId}`);
    const seenSpike = await page.evaluate(
      () =>
        (window as { __DEZFIL_LABEL_SPIKE__?: unknown })
          .__DEZFIL_LABEL_SPIKE__ ?? null,
    );
    expect(seenSpike).toBe(arm.spike);
    const layerRow = page.getByRole("button", { name: new RegExp(table) }).first();
    await expect(layerRow).toBeVisible({ timeout: 120_000 });
    await layerRow.click();

    // The render must have landed before the camera drive starts.
    const rendered = await page.evaluate(async (id) => {
      const r = await fetch(`/api/layers/${id}/render`);
      const j = (await r.json()) as { featureCount?: number };
      return j.featureCount ?? 0;
    }, layerId);
    expect(rendered).toBe(COUNT);
    // Let the first paint and the initial attribute upload settle — same
    // dwell as the slider harness, so both arms start from a warm cache.
    await page.waitForTimeout(4000);

    // Sanity check the pan actually moves the camera: screenshot before
    // and after a short synthetic drag, outside the timed loop, and
    // require the pixels to differ. If this fails, the harness itself is
    // broken (no camera motion happened) and the timed numbers below are
    // meaningless — this is a build-in TAUTOLOGY GUARD, not decoration.
    const canvasBox = await page
      .locator(".maplibregl-canvas")
      .first()
      .boundingBox();
    if (!canvasBox) throw new Error("maplibre canvas not found");
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;

    const before = await page.locator(".maplibregl-canvas").first().screenshot();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 220, cy + 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.locator(".maplibregl-canvas").first().screenshot();
    expect(before.equals(after)).toBe(false);
    // Let the eased motion from that sanity drag fully settle before the
    // timed run, so its momentum does not bleed into frame 1.
    await page.waitForTimeout(500);

    const result = (await page.evaluate(async (ticks) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        ".maplibregl-canvas",
      );
      if (!canvas) throw new Error("maplibre canvas not found");
      const rect = canvas.getBoundingClientRect();
      const cx0 = rect.left + rect.width / 2;
      const cy0 = rect.top + rect.height / 2;
      const radius = Math.min(rect.width, rect.height) * 0.18;

      const dispatch = (
        type: string,
        target: EventTarget,
        x: number,
        y: number,
        buttons: number,
      ) => {
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons,
          }),
        );
      };

      // CORRECTNESS NOTE (found at cross-model review): MapLibre's
      // HandlerManager binds `mousedown` on the canvas CONTAINER (bubbles
      // from the canvas fine), but binds the drag-tracking `mousemove` on
      // `ownerDocument` with `{capture: true}` — and, critically, the
      // mouse-pan handler's `assignEvents()` only assigns
      // `mousemoveWindow`/`mouseup`, never a plain `mousemove`. A
      // `mousemove` bubbled up to the canvas container therefore finds NO
      // handler method at all (MousePan has none named `mousemove`), and
      // one dispatched at `window` never reaches `document`'s listener
      // (window is not in that event's propagation path when it is
      // itself the dispatch target). Both of the previous version's
      // choices were dead ends — this is WHY the first version of this
      // harness measured 0/120 long frames on both arms: no camera motion
      // was ever happening inside the timed loop, only idle
      // requestAnimationFrame ticks. See node_modules/maplibre-gl/dist/
      // maplibre-gl-dev.js, HandlerManager's `_listeners` array and
      // `generateMousePanHandler`'s `assignEvents`. The fix: dispatch
      // `mousemove` AT `document` (matches the capture-phase listener's
      // registration target exactly), and `mouseup` at the canvas
      // (bubbles to the container, where `mouseup` — assigned directly,
      // unlike `mousemove` — IS handled).
      dispatch("mousedown", canvas, cx0, cy0, 1);

      // IN-LOOP TRUTH ASSERTION (review-mandated): the before/after
      // screenshot sanity check that guarded the first version of this
      // harness ran through `page.mouse`, a real CDP input path — it
      // passed even though the timed loop's own hand-dispatched events
      // were silently going nowhere, because it never exercised the same
      // code path it was meant to guard. This assertion reads the
      // builder's own status bar (`StatusBar.tsx`), which
      // MapLibre's `move` event drives independently of input method —
      // `instance.on("move", schedule)` → `getBounds()` → the BBox
      // readout — so it is direct evidence the CAMERA moved during THIS
      // loop, not a proxy for it having moved at some other time.
      const bboxEl = document.querySelector<HTMLElement>(
        'button[title="Copy bounding box"]',
      );
      if (!bboxEl) throw new Error("BBox status readout not found");
      const bboxBefore = bboxEl.textContent;

      const moveMs: number[] = [];
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
          // Smooth circular path — continuous motion, never re-lands on
          // the same point, always well past the 3px click-tolerance so
          // the drag stays engaged every frame.
          const angle = (i / ticks) * Math.PI * 4;
          const x = cx0 + radius * Math.cos(angle);
          const y = cy0 + radius * 0.55 * Math.sin(angle);
          const before = performance.now();
          dispatch("mousemove", document, x, y, 1);
          moveMs.push(performance.now() - before);
          i += 1;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      dispatch("mouseup", canvas, cx0, cy0, 0);
      // One more frame so React commits the last `move`-driven status
      // update before the truth check reads it — still inside this
      // evaluate call, still before any stat is computed.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bboxAfter = bboxEl.textContent;
      if (bboxAfter === bboxBefore) {
        throw new Error(
          `harness defect: BBox readout unchanged (${String(bboxBefore)}) — ` +
            `the timed loop's synthetic drag did not move the camera at all.`,
        );
      }
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
      // The first frame interval is the gap since instrumentation
      // started, not a rendered frame — drop it, same as the slider arm.
      frameMs.shift();
      return {
        ticks: moveMs.length,
        moveMs: stats(moveMs),
        frameMs: stats(frameMs),
        longFrames: frameMs.filter((f) => f > 20).length,
        dragMs,
      };
    }, TICKS)) as PanResult;

    lines.push(fmt(`${COUNT} features · ${arm.name} · PAN ONLY`, result));

    await page.waitForTimeout(1000);
  }

  console.log(
    "\ncamera pan only, labelled vs unlabelled, ZERO style changes\n" +
      lines.join("\n") +
      "\n",
  );
});
