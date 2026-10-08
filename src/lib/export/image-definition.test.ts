import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { validateAgainstSchema as validate } from "./schema-validate";
import {
  EXPORT_IMAGE_DEFINITION_SCHEMA,
  DEFAULT_EXPORT_ASPECT,
  DEFAULT_EXPORT_WIDTH,
  EXPORT_MIN_WIDTH,
  definitionRenderProblems,
  initialDefinition,
  resolveMapScale,
} from "./image-definition";
import {
  DEFAULT_MAP_SIZE_STEP,
  spaceGeometry,
  spaceWidthForStep,
} from "./space";

/**
 * The definition drift test: the card is an editor for a public
 * contract, so the card's state shape is asserted against the
 * documented schema — the editor and the contract cannot separate
 * silently.
 */

const seed = {
  appearance: "light" as const,
  camera: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 30, bearing: -15 },
  canvasWidth: 1482,
  legendPresent: true,
  legendCorner: "top-right" as const,
  visibleWidgetIds: ["w1", "w2"],
  basemapLayers: null,
};

/** The space a fresh card opens in: the default step at the default
 * output width and shape (shape-aware). */
const OPENING_WIDTH = spaceWidthForStep(DEFAULT_MAP_SIZE_STEP, {
  width: DEFAULT_EXPORT_WIDTH,
  height: Math.round(DEFAULT_EXPORT_WIDTH / DEFAULT_EXPORT_ASPECT),
});
const SPACE = {
  width: OPENING_WIDTH,
  scale: DEFAULT_EXPORT_WIDTH / OPENING_WIDTH,
};

const fresh = () => initialDefinition(seed, SPACE);

describe("export image definition — the public contract", () => {
  it("a fresh definition validates against the documented schema", () => {
    const def = fresh();
    expect(validate(def, EXPORT_IMAGE_DEFINITION_SCHEMA)).toEqual([]);
  });

  it("a definition with a title and toggles still validates", () => {
    const def = fresh();
    def.title = { text: "Berlin ridership", size: "l" };
    def.legend.visible = false;
    def.widgets = [];
    def.size = { width: 2560, height: 1440 };
    expect(validate(def, EXPORT_IMAGE_DEFINITION_SCHEMA)).toEqual([]);
  });

  it("every constraint class the contract uses is enforced", () => {
    const base = fresh();
    // Over-maximum size (the bounded-and-honest criterion).
    expect(
      validate(
        { ...base, size: { width: 99_999, height: 1080 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/size\.width.*maximum/);
    // Non-integer size.
    expect(
      validate(
        { ...base, size: { width: 1920.5, height: 1080 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/integer/);
    // Map scale bounds.
    expect(
      validate(
        { ...base, mapScale: 1000 },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/mapScale.*maximum/);
    // The minimum image size, raised to what a legible credit needs —
    // an image below it is refused, not exported illegibly.
    expect(
      validate(
        { ...base, size: { width: 16, height: 16 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(new RegExp(`size\\.width.*minimum ${EXPORT_MIN_WIDTH}`));
    // Appearance enum.
    expect(
      validate(
        { ...base, appearance: "sepia" },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/appearance.*allowed/);
    // Title length ceiling.
    expect(
      validate(
        { ...base, title: { text: "x".repeat(300), size: "m" } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/title\.text.*maximum/);
  });

  it("keeps the published viewport zoom boundary at 0 through 24", () => {
    const base = fresh();
    expect(
      EXPORT_IMAGE_DEFINITION_SCHEMA.properties.viewport.properties.zoom,
    ).toEqual({ type: "number", minimum: 0, maximum: 24 });
    expect(
      validate(
        { ...base, viewport: { ...base.viewport, zoom: 0 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ),
    ).toEqual([]);
    expect(
      validate(
        { ...base, viewport: { ...base.viewport, zoom: 24 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ),
    ).toEqual([]);
    expect(
      validate(
        { ...base, viewport: { ...base.viewport, zoom: 24.01 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/viewport\.zoom.*maximum 24/);
    expect(
      validate(
        { ...base, viewport: { ...base.viewport, zoom: -0.01 } },
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      ).join("\n"),
    ).toMatch(/viewport\.zoom.*minimum 0/);
  });

  it("the coverage-zoom rule refuses a camera the renderer would silently move", () => {
    const base = fresh();
    // 1440px tall at mapScale 1 needs zoom ≥ log2(1440/512) ≈ 1.49.
    const low = {
      ...base,
      size: { width: 2560, height: 1440 },
      mapScale: 1,
      viewport: { ...base.viewport, zoom: 0 },
    };
    expect(definitionRenderProblems(low).join(" ")).toMatch(/minimum/);
    // The same camera clears at a higher mapScale (a smaller space).
    const fine = { ...low, mapScale: 4 };
    expect(definitionRenderProblems(fine)).toEqual([]);
  });

  it("the working canvas is bounded, so a fine map cannot ask for the world", () => {
    const base = fresh();
    const vast = {
      ...base,
      size: { width: 4000, height: 3000 },
      mapScale: 0.25,
      viewport: { ...base.viewport, zoom: 14 },
    };
    expect(definitionRenderProblems(vast).join(" ")).toMatch(/composition pixels/);
    expect(
      definitionRenderProblems({ ...vast, mapScale: 1 }),
    ).toEqual([]);
  });

  it("accepts the earlier field name, and refuses a definition with neither", () => {
    const base = fresh();
    const withoutScale = { ...base };
    delete withoutScale.mapScale;
    const legacy = { ...withoutScale, overlayScale: 2.65 };
    // A legacy scale is nudged to one that lays out whole rather than
    // refused — the compatibility this feature promised.
    const resolved = resolveMapScale(legacy);
    expect(Math.abs(resolved - 2.65) / 2.65).toBeLessThan(0.01);
    expect(Number.isInteger(legacy.size.width / resolved)).toBe(true);
    expect(Number.isInteger(legacy.size.height / resolved)).toBe(true);
    expect(validate(legacy, EXPORT_IMAGE_DEFINITION_SCHEMA)).toEqual([]);
    expect(
      definitionRenderProblems(withoutScale as typeof base).join(" "),
    ).toMatch(/mapScale is missing/);
  });

  it("the validator genuinely fails a drifted shape (not tautological)", () => {
    const drifted = {
      ...fresh(),
      aspect: "16:9",
    } as unknown;
    expect(
      validate(drifted, EXPORT_IMAGE_DEFINITION_SCHEMA),
    ).not.toEqual([]);
    const missing = { size: { width: 100, height: 50 } };
    expect(validate(missing, EXPORT_IMAGE_DEFINITION_SCHEMA)).not.toEqual([]);
  });

  it("seeds resolve the ratified defaults: 4:3, the finest map, present state", () => {
    const def = fresh();
    // Concrete pixels — the serialized aspect is self-contained.
    expect(def.size.width).toBe(DEFAULT_EXPORT_WIDTH);
    expect(def.size.height).toBe(
      Math.round(DEFAULT_EXPORT_WIDTH / DEFAULT_EXPORT_ASPECT),
    );
    expect(resolveMapScale(def)).toBe(SPACE.scale);
    // Every element's step opens at S (field round) — the
    // published contract's absent-means-M is the renderer's fallback,
    // not the card's seed.
    expect(def.credit).toEqual({ corner: "bottom-right", size: "s" });
    expect(def.widgetSize).toBe("s");
    // Present legend and widget visibility, camera carried whole.
    expect(def.legend).toEqual({ visible: true, corner: "top-right", size: "s" });
    expect(def.widgets).toEqual(["w1", "w2"]);
    // The camera opens on the ground the builder is showing: the card's
    // space is wider than the builder canvas, so the same zoom number
    // would frame more.
    expect(def.viewport).toEqual({
      lng: 13.4,
      lat: 52.5,
      zoom: 11 + Math.log2(SPACE.width / seed.canvasWidth),
      pitch: 30,
      bearing: -15,
    });
    expect(def.title).toBeNull();
  });

  it("seeds the output size the card opens at, its height taken from that size", () => {
    const space = { width: 1920, scale: 2560 / 1920 };
    const def = initialDefinition(seed, space, { width: 2560, height: 1440 });
    expect(def.size).toEqual({ width: 2560, height: 1440 });
    expect(resolveMapScale(def)).toBe(space.scale);
    expect(def.viewport.zoom).toBe(11 + Math.log2(1920 / seed.canvasWidth));
    expect(validate(def, EXPORT_IMAGE_DEFINITION_SCHEMA)).toEqual([]);
    // Without one, the product's own: 1920 at 4:3.
    expect(initialDefinition(seed, space).size).toEqual({ width: 1920, height: 1440 });
  });

  it("the renderer operation is the schema's sole consumer, with the tool", () => {
    // asserted no consumer — deliberately, so the schema carried no tool
    // before an operation implemented it. The renderer is that
    // operation: the assertion flips to exactly-this-consumer.
    const doc = buildOpenApiDocument() as unknown as {
      components: { schemas: Record<string, unknown> };
      paths: Record<
        string,
        Record<string, { "x-tool"?: string | false; requestBody?: unknown }>
      >;
    };
    expect(doc.components.schemas.ExportImageDefinition).toBe(
      EXPORT_IMAGE_DEFINITION_SCHEMA,
    );
    const consumers = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.values(ops)
        .filter((op) =>
          JSON.stringify(op.requestBody ?? {}).includes(
            "ExportImageDefinition",
          ),
        )
        .map((op) => ({ path: p, tool: op["x-tool"] })),
    );
    expect(consumers).toEqual([
      { path: "/api/maps/{id}/export/image", tool: "export_map_image" },
    ]);
  });
});

describe("stored definitions keep their map imagery", () => {
  // The compatibility criterion's literal half: a recorded scale means
  // the same composition geometry after the short-side change as before
  // it, under either accepted spelling. The literals are the earlier
  // values, recorded — not the resolver run on both sides.
  it("the current spelling resolves to its literal geometry", () => {
    const def = { size: { width: 1600, height: 1200 }, mapScale: 2 };
    expect(resolveMapScale(def)).toBe(2);
    expect(spaceGeometry(1600, 1200, resolveMapScale(def))).toEqual({
      width: 800,
      height: 600,
      density: 2,
    });
  });

  it("seeds credit away from a stored bottom-right legend", () => {
    const def = initialDefinition(
      { ...seed, legendCorner: "bottom-right" },
      SPACE,
    );
    // Bottom-right may render standalone after its live rail measurement,
    // so the seed must reserve that band even though it starts safely docked.
    expect(def.legend.corner).toBe("bottom-right");
    expect(def.credit).toEqual({ corner: "bottom-left", size: "s" });
  });

  it("the legacy spelling resolves to its literal geometry, nudge included", () => {
    // 1600/724 divides 1600×1200 into whole pixels already (724 is a
    // multiple of 4, the divisor gcd demands), so the legacy nudge is
    // the identity here — the recorded literal proves it stays one.
    const def = {
      size: { width: 1600, height: 1200 },
      overlayScale: 1600 / 724,
    };
    expect(resolveMapScale(def)).toBeCloseTo(1600 / 724, 12);
    expect(spaceGeometry(1600, 1200, resolveMapScale(def)).width).toBeCloseTo(
      724,
      9,
    );
  });
});
