import { describe, it, expect } from "vitest";
import {
  SIZE_STEPS,
  definitionRenderProblems,
  type SizeStep,
} from "./image-definition";
import {
  SIZE_STEPS_BY_SPACE,
  chooseSize,
  legalStepFor,
  resolveSpace,
  stepChangeZoom,
  widthChangeZoom,
} from "./space";
import {
  CREDIT_BASE_PX,
  CREDIT_FLOOR_PX,
  ELEMENT_STEP_SCALE,
  EXPORT_MAX_DIMENSION,
  EXPORT_MIN_WIDTH,
  MAP_SPACE_SHORT,
  REFERENCE_SPACE_SHORT,
  REFERENCE_SPACE_WIDTH,
  WORKING_CANVAS_MAX,
  coverageMinZoom,
  creditScale,
  densityFor,
  elementScale,
  laysOutExactly,
  openingMapStep,
  snapSpaceToOutput,
  spaceWidthFor,
  spaceWidthForStep,
  stepForSpace,
  resolveShotBasemapLayers,
  stepUnavailable,
  zoomDelta,
} from "./space";

/**
 * The space arithmetic carries most of the acceptance claims, because
 * it is what the render obeys: the composition is laid out from these
 * numbers on both roads. What the browser adds is that the render really
 * does obey them — not what they are.
 */

/** The output shapes the card offers, plus the portrait the drag can
 * reach — the matrix the acceptance claims walk. */
const SHAPES = {
  "4:3": { width: 1920, height: 1440 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1920, height: 1920 },
  "1:2": { width: 1920, height: 3840 },
} as const;
type ShapeName = keyof typeof SHAPES;

/** A step's ACTUAL space for an output — nominal, then snapped the way
 * the card snaps it, keeping the output's aspect. */
function spaceFor(
  step: SizeStep,
  output: { width: number; height: number },
): { w: number; h: number } {
  const fit = snapSpaceToOutput(
    output.width,
    output.height,
    spaceWidthForStep(step, output),
  );
  return { w: fit.space, h: (fit.height * fit.space) / output.width };
}

/** An element's drawn size in output pixels, the way both hosts compose
 * it: its base size in composition pixels, scaled, then multiplied by
 * the density the definition records. */
function outputSize(
  base: number,
  space: { w: number; h: number },
  outputWidth: number,
  step: SizeStep,
): number {
  return (
    base * elementScale(space.w, space.h, step) * densityFor(outputWidth, space.w)
  );
}

/** The output sizes the card can actually hold: the offered widths
 * across the sash's whole clamp, minus the shapes its own ceiling
 * refuses — a taller shape steps the width down (`applyRatio`) and the
 * size chip that would breach it is disabled with its reason. Sweeping
 * arithmetic pairs the controls cannot produce reports defects in the
 * measurement rather than in the thing measured. */
function reachableSizes(stepBy = 0.05): Array<{ width: number; height: number }> {
  const out: Array<{ width: number; height: number }> = [];
  for (const width of [1280, 1920, 2560]) {
    for (let r = 0.5; r <= 3.0001; r += stepBy) {
      const height = Math.round(width / r);
      if (height <= EXPORT_MAX_DIMENSION) out.push({ width, height });
    }
  }
  return out;
}

/** The share of the world in frame, at a zoom, in a space of this width.
 * Web Mercator's world is 512 composition pixels at zoom 0. */
function groundFraction(spaceWidth: number, zoom: number): number {
  return spaceWidth / (512 * Math.pow(2, zoom));
}

describe("map size selects the space", () => {
  it("XS is the finest, and L's 4:3 space reproduces the earlier look", () => {
    expect(MAP_SPACE_SHORT.xs).toBeGreaterThan(MAP_SPACE_SHORT.s);
    expect(MAP_SPACE_SHORT.s).toBeGreaterThan(MAP_SPACE_SHORT.m);
    expect(MAP_SPACE_SHORT.m).toBeGreaterThan(MAP_SPACE_SHORT.l);
    // L's space at the default shape is the marks' calibration width:
    // the card's typical preview frame, which is what every export
    // used.
    expect(spaceWidthForStep("l", SHAPES["4:3"])).toBe(REFERENCE_SPACE_WIDTH);
  });

  it("derives at 4:3 exactly the widths the earlier table held (cb067193)", () => {
    // The calibration criterion's basemap half: recorded literals, not
    // the revised rule on both sides.
    expect(spaceWidthForStep("xs", SHAPES["4:3"])).toBe(1920);
    expect(spaceWidthForStep("s", SHAPES["4:3"])).toBe(1440);
    expect(spaceWidthForStep("m", SHAPES["4:3"])).toBe(1080);
    expect(spaceWidthForStep("l", SHAPES["4:3"])).toBe(720);
  });

  it("fixes a step's SHORT side across every shape", () => {
    for (const shape of Object.keys(SHAPES) as ShapeName[]) {
      const out = SHAPES[shape];
      for (const step of SIZE_STEPS) {
        const w = spaceWidthForStep(step, out);
        const h = (out.height / out.width) * w;
        expect(Math.min(w, h), `${step} at ${shape}`).toBeCloseTo(
          MAP_SPACE_SHORT[step],
          9,
        );
      }
    }
  });

  it("output width is only density — the space does not follow it", () => {
    // The correction a review of the plan forced: were the ratio
    // authored instead of the space, these two would differ and a bigger
    // export would be a different picture, not a sharper one.
    for (const step of SIZE_STEPS) {
      const space = spaceWidthForStep(step, SHAPES["16:9"]);
      expect(spaceWidthFor(1280, densityFor(1280, space))).toBeCloseTo(space, 9);
      expect(spaceWidthFor(2560, densityFor(2560, space))).toBeCloseTo(space, 9);
    }
  });

  it("a recorded density implies its space exactly, so old definitions frame the same map", () => {
    // An earlier definition recorded a density from whatever preview
    // frame it had; the space that implies is that frame.
    const legacy = { width: 1920, density: 1920 / 724 };
    expect(spaceWidthFor(legacy.width, legacy.density)).toBeCloseTo(724, 9);
  });

  it("reads a step back from a space and shape, and refuses to guess", () => {
    expect(stepForSpace(1440, SHAPES["4:3"])).toBe("s");
    expect(stepForSpace(1920, SHAPES["16:9"])).toBe("s");
    // The same width is a different step in a different shape — the
    // shape is not optional context.
    expect(stepForSpace(1440, SHAPES["16:9"])).toBe("m");
    expect(stepForSpace(1000, SHAPES["4:3"])).toBeNull();
  });
});

describe("the 4:3 baseline — recorded at cb067193", () => {
  // Every element step's drawn output size for a 200-composition-pixel
  // base at 1920 wide, computed by the earlier width rule (base × step
  // × outputWidth / 720) and recorded here as literals.
  const BASELINE: Record<SizeStep, number> = {
    xs: 346.66667,
    s: 426.66667,
    m: 533.33333,
    l: 693.33333,
  };

  it("every element step, at every basemap step, draws its recorded size", () => {
    for (const element of SIZE_STEPS) {
      for (const map of SIZE_STEPS) {
        const space = spaceFor(map, SHAPES["4:3"]);
        expect(
          outputSize(200, space, 1920, element),
          `element ${element} at map ${map}`,
        ).toBeCloseTo(BASELINE[element], 4);
      }
    }
  });

  it("the credit and the middle-step corner inset draw their recorded sizes", () => {
    const space = spaceFor("s", SHAPES["4:3"]);
    // 11px type × 1 × 1920/720, per the earlier rule.
    expect(
      CREDIT_BASE_PX *
        creditScale(space.w, space.h, "m", 1920) *
        densityFor(1920, space.w),
    ).toBeCloseTo(29.33333, 4);
    // The 12px chrome inset at the middle step: 12 × 1920/720.
    expect(outputSize(12, space, 1920, "m")).toBeCloseTo(32, 9);
  });
});

describe("an overlay's size is a share of the image's short side", () => {
  const BASE = 200;

  it("scales by 3/4 at 16:9 and 4/3 at square and portrait, from the 4:3 baseline", () => {
    for (const element of SIZE_STEPS) {
      for (const map of SIZE_STEPS) {
        const at = (shape: ShapeName) =>
          outputSize(BASE, spaceFor(map, SHAPES[shape]), 1920, element);
        const base = at("4:3");
        expect(at("16:9") / base, `${element}/${map} 16:9`).toBeCloseTo(3 / 4, 9);
        expect(at("1:1") / base, `${element}/${map} 1:1`).toBeCloseTo(4 / 3, 9);
        expect(at("1:2") / base, `${element}/${map} 1:2`).toBeCloseTo(4 / 3, 9);
      }
    }
  });

  it("is invariant across map-size steps, per element step and shape", () => {
    for (const shape of Object.keys(SHAPES) as ShapeName[]) {
      for (const element of SIZE_STEPS) {
        const shares = SIZE_STEPS.map(
          (map) =>
            outputSize(BASE, spaceFor(map, SHAPES[shape]), 1920, element) / 1920,
        );
        for (const share of shares) expect(share).toBeCloseTo(shares[0], 9);
      }
    }
  });

  it("is invariant across output widths, per element step", () => {
    for (const element of SIZE_STEPS) {
      const shares = [1280, 1920, 2560, 3011].map((w) => {
        const out = { width: w, height: Math.round((w * 9) / 16) };
        return outputSize(BASE, spaceFor("xs", out), w, element) / w;
      });
      for (const share of shares) expect(share).toBeCloseTo(shares[0], 3);
    }
  });

  it("no longer depends on the preview frame — the defect fixed", () => {
    // Before the space WAS the preview frame, so a window giving a
    // 500px frame and one giving 900px produced different shares from
    // the same settings. That contrast is the whole content of this
    // test; an earlier version also "asserted" invariance by comparing
    // one expression to itself, which could not fail and said nothing
    // (the tautological class, in this suite's own test).
    const legacyShare = (frame: number) => BASE / frame;
    expect(legacyShare(500)).not.toBeCloseTo(legacyShare(900), 3);
    // The frame is simply not an input to the share any more: the
    // browser arm varies a real window, and the arithmetic here takes
    // only the space, the step and the output width.
    expect(outputSize.length).toBe(4);
  });

  it("changes only with its own step, and keeps the S/M/L ratios", () => {
    const at = (step: SizeStep) =>
      outputSize(BASE, spaceFor("xs", SHAPES["16:9"]), 1920, step);
    expect(at("xs")).toBeLessThan(at("s"));
    expect(at("s")).toBeLessThan(at("m"));
    expect(at("m")).toBeLessThan(at("l"));
    // The ratios S/M and L/M are what they were before XS joined the ramp.
    expect(at("s") / at("m")).toBeCloseTo(0.8, 9);
    expect(at("l") / at("m")).toBeCloseTo(1.3, 9);
    expect(ELEMENT_STEP_SCALE.m).toBe(1);
  });

  it("is exact under snapping, because the space keeps the output's aspect", () => {
    // An awkward output whose snapped space travels from the nominal:
    // the short-side identity holds against the size the file actually
    // gets — the snapped output — since the composition's aspect is
    // that output's.
    const out = { width: 1001, height: 731 };
    const fit = snapSpaceToOutput(
      out.width,
      out.height,
      spaceWidthForStep("m", out),
    );
    const space = { w: fit.space, h: (fit.height * fit.space) / out.width };
    expect(outputSize(BASE, space, out.width, "m")).toBeCloseTo(
      (BASE * Math.min(out.width, fit.height)) / REFERENCE_SPACE_SHORT,
      6,
    );
  });
});

describe("changing the space holds the ground", () => {
  it("compensates the zoom so the same geography is in frame, in every shape", () => {
    for (const shape of Object.keys(SHAPES) as ShapeName[]) {
      for (const from of SIZE_STEPS) {
        for (const to of SIZE_STEPS) {
          const a = spaceWidthForStep(from, SHAPES[shape]);
          const b = spaceWidthForStep(to, SHAPES[shape]);
          const zoom = 11.4;
          const moved = zoom + zoomDelta(a, b);
          expect(groundFraction(b, moved)).toBeCloseTo(
            groundFraction(a, zoom),
            9,
          );
        }
      }
    }
  });

  it("keeps the world-coverage margin, so no step can strand the camera", () => {
    // The coverage floor moves with the space by exactly the factor the
    // camera moves — which is why the clamp survives a space change.
    const aspect = 4 / 3;
    const zoom = 3.2;
    const a = spaceWidthForStep("l", SHAPES["4:3"]);
    const marginAt = (space: number, z: number) =>
      z - coverageMinZoom(space / aspect);
    for (const step of SIZE_STEPS) {
      const b = spaceWidthForStep(step, SHAPES["4:3"]);
      expect(marginAt(b, zoom + zoomDelta(a, b))).toBeCloseTo(
        marginAt(a, zoom),
        9,
      );
    }
  });

  it("holds the short-axis ground scale across shapes at a fixed camera", () => {
    // The shape-change rule: the camera does not move, and the step's
    // short side is fixed — so the ground distance the short axis spans
    // is identical in every shape, and only the long axis gains or
    // loses coverage.
    const zoom = 11.4;
    for (const step of SIZE_STEPS) {
      const spans = (Object.keys(SHAPES) as ShapeName[]).map((shape) => {
        const out = SHAPES[shape];
        const w = spaceWidthForStep(step, out);
        const short = Math.min(w, (out.height / out.width) * w);
        return groundFraction(short, zoom);
      });
      for (const span of spans) expect(span).toBeCloseTo(spans[0], 9);
    }
  });

  it("a width change does not move the camera — same nominal space", () => {
    // At a fixed shape and step the nominal space is fixed, so a width
    // change has no delta to apply beyond the snap's own nudge.
    expect(
      zoomDelta(
        spaceWidthForStep("m", SHAPES["16:9"]),
        spaceWidthForStep("m", { width: 2560, height: 1440 }),
      ),
    ).toBe(0);
  });
});

describe("one resolution, shared by the preview and both roads", () => {
  // The card's own reachable states: the offered widths across the
  // sash's whole clamp, which is where the card's three separate snap
  // searches used to disagree with each other and with the roads.
  const REACHABLE = reachableSizes();

  it("gives the preview exactly the geometry both export roads derive", () => {
    // The roads compute `size / resolveMapScale(def)` (download.ts and
    // the render route). The preview must land on the same two numbers
    // — the HEIGHT decides overlay size too, so a disagreement is a
    // file whose overlays differ from the preview's.
    for (const size of REACHABLE) {
      for (const step of SIZE_STEPS) {
        const r = resolveSpace(size, step);
        expect(r.width, `${size.width}x${size.height} ${step}`).toBeCloseTo(
          size.width / r.scale,
          9,
        );
        expect(r.height, `${size.width}x${size.height} ${step}`).toBeCloseTo(
          size.height / r.scale,
          9,
        );
      }
    }
  });

  it("lays every reachable state out in whole composition pixels", () => {
    for (const size of REACHABLE) {
      for (const step of SIZE_STEPS) {
        const r = resolveSpace(size, step);
        expect(
          laysOutExactly(size, r.scale),
          `${size.width}x${size.height} ${step} at scale ${r.scale}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the composition's aspect equal to the output's", () => {
    // What makes the short-side identity exact under snapping.
    for (const size of REACHABLE) {
      for (const step of SIZE_STEPS) {
        const r = resolveSpace(size, step);
        expect(r.width / r.height).toBeCloseTo(size.width / size.height, 9);
      }
    }
  });
});

describe("a step stays recognisably itself", () => {
  it("resolves exactly to nominal at every preset shape and offered width", () => {
    // The shapes the card offers are the ones this must be perfect on.
    for (const width of [1280, 1920, 2560]) {
      for (const ratio of [16 / 9, 4 / 3, 1]) {
        const size = chooseSize({ width, height: Math.round(width / ratio) });
        for (const step of SIZE_STEPS) {
          expect(
            resolveSpace(size, step).width,
            `${size.width}x${size.height} ${step}`,
          ).toBeCloseTo(spaceWidthForStep(step, size), 9);
        }
      }
    }
  });

  it("keeps a custom shape's every step within a stated bound, for every step it can be switched to", () => {
    // A step change must not resize, so the committed height has to
    // suit the WHOLE ramp, not the step that happened to be selected
    // when the shape was set. Choosing on the selected step alone left
    // a 2560x3938 export whose L resolved 374% from nominal — the
    // control saying L over an XS-fine map.
    let worst = 0;
    let worstCase = "";
    for (const requested of reachableSizes(0.01)) {
      const size = chooseSize(requested);
      expect(
        Math.abs(size.height - requested.height),
        `${requested.width}x${requested.height} moved too far`,
      ).toBeLessThanOrEqual(5);
      for (const step of SIZE_STEPS) {
        const nominal = spaceWidthForStep(step, size);
        const drift =
          Math.abs(resolveSpace(size, step).width - nominal) / nominal;
        if (drift > worst) {
          worst = drift;
          worstCase = `${size.width}x${size.height} ${step}`;
        }
      }
    }
    // The tolerance the chooser guarantees, not a loose bound above
    // the number that happens to come out: at ±3 a tail of shapes sat
    // at 22% and this read `< 0.25`, which recorded the defect rather
    // than catching it.
    expect(worst, `worst at ${worstCase}`).toBeLessThanOrEqual(0.15 + 1e-9);
  });
});

describe("the camera splits by cause", () => {
  const SHAPES_ALL: Array<{ width: number; height: number }> = [
    { width: 1920, height: 1440 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 1920 },
    { width: 1920, height: 3840 },
    // Custom shapes the sash reaches, where the resolved space and the
    // nominal diverge — the states the old nominal-vs-resolved mismatch
    // moved the ground on.
    { width: 2560, height: 2394 },
    { width: 1280, height: 435 },
    { width: 1920, height: 1357 },
  ];

  it("a step change holds the ground in every reachable shape", () => {
    // Red against compensating from the memo's space to a differently
    // snapped one: that pair disagreed by up to 2 zoom levels on a
    // custom shape, and this asserts on the SAME resolver the render
    // uses, so it cannot pass while the render disagrees.
    for (const size of SHAPES_ALL) {
      for (const from of SIZE_STEPS) {
        for (const to of SIZE_STEPS) {
          const zoom = 11.4;
          const moved = stepChangeZoom(size, from, to, zoom);
          const a = resolveSpace(size, from).width;
          const b = resolveSpace(size, to).width;
          expect(
            groundFraction(b, moved),
            `${size.width}x${size.height} ${from}→${to}`,
          ).toBeCloseTo(groundFraction(a, zoom), 9);
        }
      }
    }
  });

  it("a step change never resizes the output", () => {
    for (const size of SHAPES_ALL) {
      for (const step of SIZE_STEPS) {
        const r = resolveSpace(size, step);
        expect(r.width * r.scale).toBeCloseTo(size.width * 1, 6);
        expect(Math.round(r.height * r.scale)).toBe(size.height);
      }
    }
  });

  it("a width change at a fixed shape holds the ground", () => {
    for (const step of SIZE_STEPS) {
      for (const ratio of [16 / 9, 4 / 3, 1, 0.5]) {
        const a = { width: 1280, height: Math.round(1280 / ratio) };
        const b = { width: 2560, height: Math.round(2560 / ratio) };
        const zoom = 11.4;
        const moved = widthChangeZoom(a, b, step, zoom);
        expect(
          groundFraction(resolveSpace(b, step).width, moved),
        ).toBeCloseTo(
          groundFraction(resolveSpace(a, step).width, zoom),
          6,
        );
      }
    }
  });

  it("a shape change is not a camera change — the short axis holds its ground scale", () => {
    // The other half of the split: `applyRatio` passes no ground-hold,
    // so the camera stays and the short side's ground span is what
    // stays fixed.
    //
    // Compared as a RATIO, because these spans are absolute fractions
    // near 8e-4 and `toBeCloseTo(x, 2)` admits 5e-3 — six times the
    // quantity — so a span of zero, or double the right one, passed.
    // That assertion could not fail on any error it was watching for,
    // and it was mine. On
    // the nominal spaces the identity is exact; on the
    // resolved ones it holds inside the same tolerance the size
    // chooser guarantees.
    const zoom = 11.4;
    for (const step of SIZE_STEPS) {
      const nominal = SHAPES_ALL.map((size) => {
        const w = spaceWidthForStep(step, size);
        const short = Math.min(w, (size.height / size.width) * w);
        return groundFraction(short, zoom);
      });
      for (const span of nominal) {
        expect(span / nominal[0]).toBeCloseTo(1, 9);
      }

      const resolvedSpans = SHAPES_ALL.map((raw) => {
        const size = chooseSize(raw);
        const r = resolveSpace(size, step);
        return groundFraction(Math.min(r.width, r.height), zoom);
      });
      for (const span of resolvedSpans) {
        expect(Math.abs(span / resolvedSpans[0] - 1)).toBeLessThanOrEqual(0.15);
      }
    }
  });

  it("that ground-span comparison can actually fail", () => {
    // The guard on the guard: a DOUBLED span must be rejected by the
    // form the assertion above uses, and would have been accepted by
    // the form it replaced. Without this, "compared as a ratio" is a
    // claim about the code rather than a demonstrated one.
    const zoom = 11.4;
    const right = groundFraction(1080, zoom);
    const doubled = groundFraction(2160, zoom);
    expect(Math.abs(doubled / right - 1)).toBeGreaterThan(0.15);
    expect(Math.abs(doubled - right)).toBeLessThan(0.005);
    // A span of zero slipped through the old form too.
    expect(Math.abs(0 - right)).toBeLessThan(0.005);
  });
});

describe("a shape change cannot strand the selected step", () => {
  it("keeps a legal step exactly where it is", () => {
    const size = { width: 1920, height: 1080 };
    for (const step of SIZE_STEPS) {
      expect(
        legalStepFor(step, size, 11, resolveSpace(size, step).width),
      ).toBe(step);
    }
  });

  it("degrades a step the shape pushed past the working canvas", () => {
    // XS crosses the 4096 bound at about 2.84:1, inside the sash's own
    // 3:1 clamp. Red against leaving the selection: before this, the
    // card held a definition `definitionRenderProblems` refuses while
    // the browser road still wrote a file.
    const banner = { width: 1920, height: 640 };
    expect(stepUnavailable("xs", banner, 11, 1440)).toContain(
      String(WORKING_CANVAS_MAX),
    );
    const landed = legalStepFor(
      "xs",
      banner,
      11,
      resolveSpace(banner, "xs").width,
    );
    expect(landed).not.toBe("xs");
    expect(stepUnavailable(landed, banner, 11, resolveSpace(banner, "xs").width))
      .toBeNull();
  });

  it("never lands on a step that is itself unofferable, across the sash's whole range", () => {
    for (const size of reachableSizes()) {
      for (const step of SIZE_STEPS) {
        const current = resolveSpace(size, step).width;
        const landed = legalStepFor(step, size, 11, current);
        expect(
          stepUnavailable(landed, size, 11, current),
          `${size.width}x${size.height} from ${step} landed on ${landed}`,
        ).toBeNull();
      }
    }
  });

  it("coarsens by preference, and only goes finer when no coarser step is legal", () => {
    // The resolved space is not monotonic in the step, so coarsening is
    // a preference rather than a guarantee — but a finer landing is
    // only ever taken when every coarser step was refused, and the
    // alternative would be stranding the selection on an illegal step.
    const order = [...SIZE_STEPS_BY_SPACE];
    for (const size of reachableSizes(0.1)) {
      for (const step of SIZE_STEPS) {
        const current = resolveSpace(size, step).width;
        const landed = legalStepFor(step, size, 11, current);
        if (order.indexOf(landed) >= order.indexOf(step)) continue;
        for (const coarser of order.slice(order.indexOf(step))) {
          expect(
            stepUnavailable(coarser, size, 11, current),
            `${size.width}x${size.height} went finer to ${landed} while ${coarser} was legal`,
          ).not.toBeNull();
        }
      }
    }
  });

  it("every reachable state resolves to a definition the render road accepts", () => {
    // The end the whole fix exists for: what the card can be driven
    // into must not be something the server refuses. Drives the card's
    // own arithmetic — degrade included — through the public guard.
    //
    // "Reachable" is the card's own bound, not every arithmetic pair:
    // a shape that would push the height past EXPORT_MAX_DIMENSION
    // steps the width down instead (`applyRatio`), and the size chip
    // that would do it is disabled with its reason. The first version
    // of this sweep omitted that and "found" 2560×4267 — a size no
    // control can produce, which is a defect in the measurement rather
    // than in the thing measured.
    for (const size of reachableSizes()) {
      for (const step of SIZE_STEPS) {
        const landed = legalStepFor(
          step,
          size,
          11,
          resolveSpace(size, step).width,
        );
        const problems = definitionRenderProblems({
          viewport: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 0, bearing: 0 },
          size,
          legend: { visible: false, corner: "bottom-left", size: "s" },
          widgets: [],
          title: null,
          appearance: "light",
          mapScale: resolveSpace(size, landed).scale,
        });
        expect(
          problems,
          `${size.width}x${size.height} at ${landed}: ${problems.join(" ")}`,
        ).toEqual([]);
      }
    }
  });
});

describe("the attribution's floor", () => {
  const creditPx = (
    space: { w: number; h: number },
    width: number,
    step: SizeStep,
  ) =>
    CREDIT_BASE_PX *
    creditScale(space.w, space.h, step, width) *
    densityFor(width, space.w);

  it("follows the share rule while it is above the floor", () => {
    const space = spaceFor("xs", SHAPES["4:3"]);
    const px = creditPx(space, 1920, "m");
    expect(px).toBeCloseTo((CREDIT_BASE_PX * 1920) / REFERENCE_SPACE_WIDTH, 9);
    expect(px).toBeGreaterThan(CREDIT_FLOOR_PX);
  });

  it("stops shrinking at the floor on a small image", () => {
    // The one place the floor beats the share rule.
    const out = { width: 360, height: 270 };
    const small = creditPx(spaceFor("xs", out), 360, "xs");
    expect(small).toBeCloseTo(CREDIT_FLOOR_PX, 9);
  });

  it("never renders below the floor at any offered combination", () => {
    for (const shape of Object.keys(SHAPES) as ShapeName[]) {
      const ratio = SHAPES[shape].height / SHAPES[shape].width;
      for (const step of SIZE_STEPS) {
        for (const map of SIZE_STEPS) {
          for (const width of [320, 640, 1280, 1920, 2560, 4096]) {
            const out = { width, height: Math.round(width * ratio) };
            expect(
              creditPx(spaceFor(map, out), width, step),
              `${step}/${map}/${shape}/${width}`,
            ).toBeGreaterThanOrEqual(CREDIT_FLOOR_PX - 1e-9);
          }
        }
      }
    }
  });
});

describe("a step that cannot be offered says why", () => {
  const output = SHAPES["4:3"];
  const currentSpace = (step: SizeStep) => spaceWidthForStep(step, output);

  it("offers every step for an ordinary view", () => {
    for (const step of SIZE_STEPS) {
      expect(stepUnavailable(step, output, 11, currentSpace("l"))).toBeNull();
    }
  });

  it("refuses a space past the working canvas — on either axis", () => {
    const tall = { width: 4000, height: 4000 };
    // A portrait sliver overruns the vertical bound…
    const sliver = { width: 4000, height: 4000 * 3 };
    // …and a landscape banner now overruns the horizontal one: XS at
    // 3:1 derives a 4320-wide space. Under the earlier width table
    // this shape was allowed and drew microscopic labels instead.
    const banner = { width: 3840, height: 1280 };
    expect(stepUnavailable("xs", tall, 11, 1440)).toBeNull();
    expect(stepUnavailable("xs", sliver, 11, 1440)).toContain(
      String(WORKING_CANVAS_MAX),
    );
    expect(stepUnavailable("xs", banner, 11, 1440)).toContain(
      String(WORKING_CANVAS_MAX),
    );
    expect(stepUnavailable("l", banner, 11, 1440)).toBeNull();
  });

  it("allows framing through zoom 24 and refuses a finer step above it", () => {
    const deltaToXs = zoomDelta(currentSpace("l"), currentSpace("xs"));

    // This exact boundary was refused when framing still used the engine's
    // former default ceiling of 22.
    expect(
      stepUnavailable("xs", output, 24 - deltaToXs, currentSpace("l")),
    ).toBeNull();
    expect(
      stepUnavailable("xs", output, 24.01 - deltaToXs, currentSpace("l")),
    ).toMatch(/as far in as it goes/);

    // The fresh-card chooser opens at S; a camera that can still hold
    // XS holds S a fortiori, and the chooser answers S.
    expect(openingMapStep(24 - deltaToXs, currentSpace("l"))).toBe("s");
  });

  it("refuses an opening when no fixed step can hold a narrow zoom-24 view", () => {
    // Red against the former L fallback: 720px is the coarsest opening
    // space, so moving a 608px-wide zoom-24 view into it would require a
    // camera beyond the public/runtime ceiling.
    expect(openingMapStep(24, 608)).toBeNull();
  });

  it("keeps L at the exact zoom-24 opening boundary", () => {
    expect(openingMapStep(24, 720)).toBe("l");
  });

  it("degrades to the first supported coarser step below the boundary", () => {
    // At zoom 23 from 608px, S still requires more than zoom 24; M is
    // the first coarser step that preserves the ground legally (the
    // scan starts at S and only ever coarsens).
    expect(openingMapStep(23, 608)).toBe("m");
  });

  it("opens at S when the camera is unconstrained", () => {
    expect(openingMapStep(10, 1200)).toBe("s");
  });

  it("never refuses a coarser step — the coverage margin cannot be crossed", () => {
    // The counterpart of the margin-invariance test above: because the
    // world-coverage floor moves with the space by the same factor as
    // the camera, no step change can strand a valid camera. This is why
    // `stepUnavailable` carries no coverage check — a branch that could
    // only fire from an impossible state is a branch that never fires.
    for (const zoom of [0.2, 1.6, 4, 11, 18]) {
      for (const from of SIZE_STEPS) {
        expect(
          stepUnavailable("l", output, zoom, currentSpace(from)),
        ).toBeNull();
      }
    }
  });
});

describe("a composition can only be laid out in whole pixels", () => {
  const NOMINALS = [2560, 1920, 1440, 1080, 960, 810, 720, 540];

  it("always lands a space that divides the output exactly", () => {
    for (const width of [1280, 1920, 2560, 913, 1001]) {
      for (const nominal of NOMINALS) {
        for (const height of [720, 1080, 1234, 667, 999]) {
          const snapped = snapSpaceToOutput(width, height, nominal);
          expect(Number.isInteger(snapped.space)).toBe(true);
          expect(
            laysOutExactly(
              { width, height: snapped.height },
              width / snapped.space,
            ),
            `${width}x${height} in a ${nominal} space`,
          ).toBe(true);
          // The author's size moves by at most a pixel or two, always.
          expect(Math.abs(snapped.height - height)).toBeLessThanOrEqual(3);
          // The step stays recognisably itself at the widths the card
          // offers. A hand-written definition may name an output width
          // that shares no factors with anything, and there the space
          // has to travel further — the exactness above is what is
          // promised there, not the step.
          if (([1280, 1920, 2560] as number[]).includes(width)) {
            expect(
              Math.abs(snapped.space - nominal),
              `${width}x${height} in a ${nominal} space`,
            ).toBeLessThan(nominal * 0.15);
          }
        }
      }
    }
  });

  it("keeps the author's size untouched wherever it can", () => {
    // The presets are the cases that matter most: a 16:9 or 4:3 export
    // at any offered width must be exactly those pixels — with the
    // shape-aware nominal each step now derives for that shape.
    for (const width of [1280, 1920, 2560]) {
      for (const ratio of [16 / 9, 4 / 3, 1]) {
        const height = Math.round(width / ratio);
        for (const step of SIZE_STEPS) {
          const nominal = spaceWidthForStep(step, { width, height });
          const snapped = snapSpaceToOutput(width, height, nominal);
          expect(
            snapped.height,
            `${width}x${height} in a ${nominal} space`,
          ).toBe(height);
        }
      }
    }
  });

  it("catches the case that shipped a pixel short", () => {
    // 913x667 at scale 1.37 lays out as 666.42 composition pixels tall
    // and screenshotted 913x666 — found by the acceptance criterion, not
    // by review.
    expect(laysOutExactly({ width: 913, height: 667 }, 1.37)).toBe(false);
    expect(laysOutExactly({ width: 913, height: 667 }, 1)).toBe(true);
  });
});

describe("a shot's basemap groups", () => {
  it("prefers the definition's resolved set over the map's stored one", () => {
    const stored: Record<string, boolean> = { labels: false };
    expect(resolveShotBasemapLayers({ roads: false }, stored)).toEqual({
      roads: false,
    });
  });

  it("falls back to the map only when the definition says nothing", () => {
    const stored: Record<string, boolean> = { labels: false };
    expect(resolveShotBasemapLayers(undefined, stored)).toBe(stored);
  });

  it("treats an explicit null as an answer, not as silence", () => {
    // "Draw everything" is a choice a definition can make, and it must
    // not be overwritten by whatever the map happens to hide.
    expect(resolveShotBasemapLayers(null, { labels: false })).toBeNull();
  });
});

describe("the minimum image can carry the longest credit it may have to", () => {
  it("covers the widest built-in attribution at the floor", async () => {
    const { BASEMAPS } = await import("@/lib/basemap");
    // Every built-in credit, plus the separator and the quiet mark the
    // composition always draws beside it.
    const longest = Math.max(
      ...BASEMAPS.map(
        (b) =>
          b.attribution.map((a) => a.label).join(" ").length +
          " · Made with Dezfil".length,
      ),
    );
    // Inter at the 9px floor averages a shade under half an em; 4.8px
    // per character is the conservative side of that, and the credit's
    // inset is drawn at the same scale.
    const needed = longest * 4.8 + 2 * 10;
    expect(
      EXPORT_MIN_WIDTH,
      `the widest built-in credit needs about ${Math.ceil(needed)}px`,
    ).toBeGreaterThanOrEqual(needed);
  });
});
