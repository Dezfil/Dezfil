import { afterEach, describe, expect, it, vi } from "vitest";
import { _LayersPass as LayersPass, type Layer } from "@deck.gl/core";
import { CollisionFilterExtension } from "@deck.gl/extensions";
import type { LabelStyle } from "@/lib/style/style";
import type { LabeledFeature } from "@/lib/style/deck-style";
import type { ClusterBubble } from "@/lib/cluster";
import {
  COLLISION_FOOTPRINT,
  clusterCountSublayer,
  mvtRenderSubLayers,
  textSublayer,
} from "./text-sublayer";

/**
 * The label layers' two rules: the overlap test sees each label's whole box,
 * and every text layer names the label face.
 */

const LABEL: LabelStyle = {
  attribute: "name",
  size: 12,
  color: { r: 255, g: 255, b: 255, a: 1 },
  haloWidth: 1,
  haloColor: { r: 29, g: 31, b: 36, a: 0.85 },
};
const FACE = '"Inter", "Inter Fallback"';
const feature = (name: string): LabeledFeature =>
  ({ type: "Feature", properties: { name }, geometry: { type: "Point", coordinates: [30, -2] } }) as unknown as LabeledFeature;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the overlap test's footprint", () => {
  it("is the label's whole box, drawn transparent, wherever labels thin", () => {
    const layer = textSublayer("districts:labels", [feature("Gatsibo · 21.4%")], LABEL, null, null, 1, 1, FACE);
    expect((layer.props as unknown as { collisionGroup?: string }).collisionGroup).toBe("districts:labels");
    expect(layer.props.background).toBe(true);
    // Nothing of it reaches the map: fully transparent.
    expect(COLLISION_FOOTPRINT.getBackgroundColor[3]).toBe(0);
    expect(layer.props.getBackgroundColor).toEqual([0, 0, 0, 0]);
  });

  it("is absent where labels are drawn without thinning", () => {
    vi.stubGlobal("window", { __DEZFIL_LABEL_SPIKE__: "always-draw" });
    const layer = textSublayer("districts:labels", [feature("Gatsibo")], LABEL, null, null, 1, 1, FACE);
    expect(layer.props.background).toBe(false);
  });
});

/** The draw parameters deck's own passes give a layer with these props:
 * the normal pass, and the collision pass the overlap test draws in,
 * reached through the extension's own effect. */
type ParameterPass = { getLayerParameters(layer: Layer, index: number, viewport: unknown): unknown };

function passParameters(props: Record<string, unknown>) {
  const device = { createTexture: () => ({}) } as never;
  let effect: { setup(context: unknown): void; collisionFilterPass: ParameterPass } | undefined;
  const extension = new CollisionFilterExtension();
  extension.initializeState.call(
    {
      getAttributeManager: () => ({ add: () => undefined }),
      context: { deck: { _addDefaultEffect: (added: typeof effect) => { effect = added; } } },
    } as never,
    {} as never,
    extension,
  );
  effect!.setup({ device });
  const layer = { props } as unknown as Layer;
  return {
    normal: (new LayersPass(device) as unknown as ParameterPass).getLayerParameters(layer, 0, null) as Record<string, unknown> | undefined,
    collision: effect!.collisionFilterPass.getLayerParameters(layer, 0, null) as Record<string, unknown>,
  };
}

/** A sublayer's props as the label layer hands them down. */
const subLayerProps = (layer: ReturnType<typeof textSublayer>, id: "background" | "characters") =>
  (layer as unknown as { getSubLayerProps(props: { id: string }): Record<string, unknown> }).getSubLayerProps({ id });

describe("the footprint's box on the map", () => {
  // Invisible, the box must hide nothing either: drawn writing depth, it
  // would keep whatever is drawn after it and lies behind the label's point
  // from showing through it on a pitched map.
  it("writes no depth where the map is drawn, and still does where the overlap test draws", () => {
    const layer = textSublayer("districts:labels", [feature("Gatsibo")], LABEL, null, null, 1, 1, FACE);
    const box = passParameters(subLayerProps(layer, "background"));
    expect(box.normal?.depthWriteEnabled).toBe(false);
    expect(box.collision.depthWriteEnabled).toBe(true);
  });

  it("leaves the glyphs as they were: they keep their depth where they have ink", () => {
    const layer = textSublayer("districts:labels", [feature("Gatsibo")], LABEL, null, null, 1, 1, FACE);
    const glyphs = passParameters(subLayerProps(layer, "characters"));
    expect(glyphs.normal?.depthWriteEnabled).toBeUndefined();
    expect(glyphs.collision.depthWriteEnabled).toBe(true);
  });
});

describe("the face every text layer names", () => {
  it("is the label face on a feature layer's labels", () => {
    const layer = textSublayer("districts:labels", [feature("Gatsibo")], LABEL, null, null, 1, 1, FACE);
    expect(layer.props.fontFamily).toBe(FACE);
  });

  it("is the label face on a tile's labels", () => {
    const render = mvtRenderSubLayers(LABEL, () => "marks", FACE);
    const drawn = render({ id: "tile-0", data: [feature("Gatsibo")] });
    expect(Array.isArray(drawn)).toBe(true);
    const [, labels] = drawn as [string, { props: { fontFamily: string } }];
    expect(labels.props.fontFamily).toBe(FACE);
  });

  it("is the label face on cluster counts", () => {
    const bubble: ClusterBubble = { position: [30, -2], count: 12, value: null, clusterId: 1, expansionZoom: 9, properties: {} };
    const layer = clusterCountSublayer("points:cluster-counts", [bubble], 1, 1, [7], FACE);
    expect(layer.props.fontFamily).toBe(FACE);
  });
});
