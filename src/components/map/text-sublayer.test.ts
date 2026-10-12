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
import { LABEL_COLLISION_GROUP, labelCollisionUniforms, labelStacks } from "./label-collision";

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
    expect((layer.props as unknown as { collisionGroup?: string }).collisionGroup).toBe(LABEL_COLLISION_GROUP);
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

/** A label layer's place among the map's label layers, the lowest first. */
const placed = (place: number, count: number) => ({ place, count });
type Thinned = { props: Record<string, unknown> & {
  collisionGroup?: string;
  collisionTag?: number;
  collisionEnabled?: boolean;
  getCollisionPriority(f: LabeledFeature, info: { index: number }): number;
  updateTriggers: Record<string, unknown>;
} };
const thinned = (layer: ReturnType<typeof textSublayer>) => layer as unknown as Thinned;
const ranks = (layer: ReturnType<typeof textSublayer>, count: number) =>
  Array.from({ length: count }, (_, index) => thinned(layer).props.getCollisionPriority(feature(""), { index }));

describe("one overlap test for every label on a map", () => {
  // Napoleon's march: the towns in one layer, Minard's temperatures in a
  // layer above it, over the same places.
  const towns = [feature("Moscou"), feature("Smolensk"), feature("Studzianka")];
  const temperatures = [feature("0°"), feature("-21°"), feature("-24°")];

  it("puts every layer's labels in the same test, the upper layer's ranked above the lower's", () => {
    const lower = thinned(textSublayer("towns:labels", towns, LABEL, null, null, 1, 1, FACE, placed(0, 2)));
    const upper = thinned(textSublayer("temperatures:labels", temperatures, LABEL, null, null, 1, 1, FACE, placed(1, 2)));
    expect(lower.props.collisionGroup).toBeDefined();
    expect(upper.props.collisionGroup).toBe(lower.props.collisionGroup);
    const below = ranks(lower as never, towns.length);
    const above = ranks(upper as never, temperatures.length);
    expect(Math.min(...above)).toBeGreaterThan(Math.max(...below));
    // Inside a layer the label ranking still decides: the first label first.
    for (const layer of [below, above]) {
      expect(layer).toEqual([...layer].sort((a, b) => b - a));
      expect(new Set(layer).size).toBe(layer.length);
    }
    // All inside the range the collision map's depth carries.
    for (const rank of [...below, ...above]) {
      expect(Math.abs(rank)).toBeLessThan(1000);
    }
  });

  it("tells two layers' labels apart even where they hold the same place in their own layers", () => {
    const lower = thinned(textSublayer("towns:labels", towns, LABEL, null, null, 1, 1, FACE, placed(0, 2)));
    const upper = thinned(textSublayer("temperatures:labels", temperatures, LABEL, null, null, 1, 1, FACE, placed(1, 2)));
    expect(lower.props.collisionTag).toBeGreaterThan(0);
    expect(upper.props.collisionTag).toBeGreaterThan(0);
    expect(upper.props.collisionTag).not.toBe(lower.props.collisionTag);
    // The tag reaches what the overlap test draws and reads: both sublayers.
    for (const id of ["background", "characters"] as const) {
      expect(subLayerProps(upper as never, id).collisionTag).toBe(upper.props.collisionTag);
    }
    // And the shader, as the collision map's alpha.
    expect(labelCollisionUniforms({ label: { tag: upper.props.collisionTag! } }).tag).toBe(upper.props.collisionTag! / 255);
  });

  it("re-ranks a layer's labels when its place in the stack changes", () => {
    const trigger = (stack: { place: number; count: number }) =>
      JSON.stringify(thinned(textSublayer("towns:labels", towns, LABEL, null, null, 1, 1, FACE, stack)).props.updateTriggers.getCollisionPriority);
    expect(new Set([trigger(placed(0, 1)), trigger(placed(0, 2)), trigger(placed(1, 2))]).size).toBe(3);
  });

  it("keeps a layer drawn at opacity 0 out of it: a label nobody sees takes no one's place", () => {
    const gone = thinned(textSublayer("towns:labels", towns, LABEL, null, null, 0, 1, FACE, placed(1, 2)));
    const shown = thinned(textSublayer("towns:labels", towns, LABEL, null, null, 0.4, 1, FACE, placed(1, 2)));
    expect(gone.props.collisionEnabled).toBe(false);
    expect(shown.props.collisionEnabled).toBe(true);
  });

  it("reads each label's own box, as the text layer lays it out, in what draws its letters and its box", () => {
    const layer = textSublayer("towns:labels", towns, { ...LABEL, anchor: "right", offsetX: 12 }, null, null, 1, 1, FACE, placed(0, 2));
    const layout = (layer as unknown as { getBoundingRect: unknown }).getBoundingRect;
    expect(typeof layout).toBe("function");
    for (const id of ["background", "characters"] as const) {
      const props = subLayerProps(layer, id) as { getCollisionBox?: unknown; updateTriggers: Record<string, unknown> };
      expect(props.getCollisionBox, id).toBe(layout);
      expect(props.updateTriggers.getCollisionBox, id).toBeDefined();
    }
  });

  it("keeps a label nobody can see out of it, whatever the layer's opacity", () => {
    const clear = { r: 0, g: 0, b: 0, a: 0 };
    const takesPart = (label: LabelStyle, opacity = 1) =>
      thinned(textSublayer("ghosts:labels", towns, label, null, null, opacity, 1, FACE, placed(1, 2))).props.collisionEnabled;
    // No ink and no halo: nothing on the map, nothing claimed.
    expect(takesPart({ ...LABEL, color: clear, haloWidth: 0 }), "no ink, no halo").toBe(false);
    expect(takesPart({ ...LABEL, color: clear, haloWidth: 1, haloColor: clear }), "no ink, a clear halo").toBe(false);
    // Either one seen is a label to keep clear of.
    expect(takesPart({ ...LABEL, color: clear }), "a halo alone").toBe(true);
    expect(takesPart({ ...LABEL, haloWidth: 0 }), "ink alone").toBe(true);
    expect(takesPart(LABEL, 0), "a layer at opacity 0").toBe(false);
  });

  it("stacks the label layers as the map draws them, the lowest first", () => {
    const stacks = labelStacks(["towns", "temperatures"]);
    expect(stacks.get("towns")).toEqual(placed(0, 2));
    expect(stacks.get("temperatures")).toEqual(placed(1, 2));
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
