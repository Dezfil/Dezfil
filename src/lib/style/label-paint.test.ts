import { describe, expect, it } from "vitest";
import type { LabeledFeature } from "@/lib/style/deck-style";
import { layerOpacity } from "@/lib/style/deck-style";
import { mvtRenderSubLayers, textSublayer } from "@/components/map/text-sublayer";
import { labelPaint, paintedLabel } from "./label-paint";
import type { LabelStyle } from "./style";

/**
 * What a label is drawn with over a basemap of a given tone. The recipes are
 * written out here as the hex values the label's automatic paint names, not
 * read back from the code under test.
 */

const LIGHT = {
  color: { r: 0x24, g: 0x32, b: 0x30, a: 1 },
  haloWidth: 1.5,
  haloColor: { r: 255, g: 255, b: 255, a: 1 },
};
const DARK = {
  color: { r: 0xe9, g: 0xec, b: 0xf3, a: 1 },
  haloWidth: 1.5,
  haloColor: { r: 0x0b, g: 0x0e, b: 0x14, a: 1 },
};
/** A colour of the label's own, half transparent. */
const OWN = { r: 200, g: 40, b: 40, a: 0.5 };
const OWN_HALO = { r: 10, g: 20, b: 30, a: 0.25 };

const label = (paint: Partial<LabelStyle>): LabelStyle => ({
  attribute: "name",
  size: 12,
  color: OWN,
  haloWidth: 2,
  haloColor: OWN_HALO,
  ...paint,
});

/** A drawn sublayer, read only for its props. */
type Drawn = { props: unknown };

describe("a label's paint for a tone", () => {
  it("follows the map in both parts: the tone's recipe, opaque", () => {
    const automatic = label({ textPaint: "automatic", haloPaint: "automatic" });
    expect(labelPaint(automatic, "light")).toEqual(LIGHT);
    expect(labelPaint(automatic, "dark")).toEqual(DARK);
    for (const tone of ["light", "dark"] as const) {
      const paint = labelPaint(automatic, tone);
      expect(paint.color.a).toBe(1);
      expect(paint.haloColor.a).toBe(1);
    }
  });

  it("keeps a colour of the label's own exactly, its authored alpha included, over either tone", () => {
    const own = label({ textPaint: "own", haloPaint: "own" });
    for (const tone of ["light", "dark"] as const) {
      expect(labelPaint(own, tone)).toEqual({ color: OWN, haloWidth: 2, haloColor: OWN_HALO });
    }
  });

  it("takes each part from its own choice: automatic text over an own halo, and the other way round", () => {
    expect(labelPaint(label({ textPaint: "automatic", haloPaint: "own" }), "dark")).toEqual({
      color: DARK.color,
      haloWidth: 2,
      haloColor: OWN_HALO,
    });
    expect(labelPaint(label({ textPaint: "own", haloPaint: "automatic" }), "dark")).toEqual({
      color: OWN,
      haloWidth: DARK.haloWidth,
      haloColor: DARK.haloColor,
    });
  });

  it("draws a label that carries no choice as given", () => {
    expect(labelPaint(label({}), "dark")).toEqual({ color: OWN, haloWidth: 2, haloColor: OWN_HALO });
  });

  it("paints the label the renderer draws, leaving every other setting and the label given alone", () => {
    const automatic = label({ textPaint: "automatic", haloPaint: "own", weight: "bold", anchor: "top" });
    const painted = paintedLabel(automatic, "dark");
    expect(painted).toEqual({ ...automatic, color: DARK.color });
    expect(automatic.color).toBe(OWN);
    // Nothing to paint: the very label given, so nothing downstream sees a change.
    const own = label({ textPaint: "own", haloPaint: "own" });
    expect(paintedLabel(own, "dark")).toBe(own);
  });
});

/**
 * The layer's opacity is not the paint's: the text layer applies it once,
 * through its own gamma curve, on a feature layer's labels; a tile's labels
 * inherit the tiled layer's. A half-transparent label on a half-transparent
 * layer keeps its own alpha in its colours and the layer's in its opacity.
 */
describe("a partly transparent label on a partly transparent layer", () => {
  const feature = { type: "Feature", properties: { name: "Gatsibo" }, geometry: { type: "Point", coordinates: [30, -2] } } as unknown as LabeledFeature;
  const own = label({ textPaint: "own", haloPaint: "own" });
  const opacity = layerOpacity(0.5);
  type TextProps = { getColor: number[]; outlineColor: number[]; opacity: number };

  it("keeps the label's alpha and the layer's opacity apart on a feature layer's labels", () => {
    const layer = textSublayer("districts:labels", [feature], paintedLabel(own, "light"), null, null, opacity);
    const props = layer.props as unknown as TextProps;
    expect(props.getColor).toEqual([200, 40, 40, 128]);
    expect(props.outlineColor).toEqual([10, 20, 30, 64]);
    expect(props.opacity).toBe(opacity);
  });

  it("keeps them apart on a tile's labels, which take the tiled layer's opacity as it is", () => {
    const render = mvtRenderSubLayers(paintedLabel(own, "dark"), () => "marks");
    const drawn = render({ id: "tile-0", data: [feature], opacity } as Parameters<typeof render>[0]);
    const [, labels] = drawn as [string, Drawn];
    const props = labels.props as unknown as TextProps;
    expect(props.getColor).toEqual([200, 40, 40, 128]);
    expect(props.outlineColor).toEqual([10, 20, 30, 64]);
    expect(props.opacity).toBe(opacity);
  });

  it("draws an automatic label opaque on the same layer, the layer's opacity on top", () => {
    const automatic = label({ textPaint: "automatic", haloPaint: "automatic" });
    const simple = textSublayer("districts:labels", [feature], paintedLabel(automatic, "dark"), null, null, opacity).props as unknown as TextProps;
    expect(simple.getColor).toEqual([0xe9, 0xec, 0xf3, 255]);
    expect(simple.outlineColor).toEqual([0x0b, 0x0e, 0x14, 255]);
    expect(simple.opacity).toBe(opacity);
    const render = mvtRenderSubLayers(paintedLabel(automatic, "light"), () => "marks");
    const [, labels] = render({ id: "tile-0", data: [feature], opacity } as Parameters<typeof render>[0]) as [string, Drawn];
    const tiled = labels.props as unknown as TextProps;
    expect(tiled.getColor).toEqual([0x24, 0x32, 0x30, 255]);
    expect(tiled.outlineColor).toEqual([255, 255, 255, 255]);
    expect(tiled.opacity).toBe(opacity);
  });
});
