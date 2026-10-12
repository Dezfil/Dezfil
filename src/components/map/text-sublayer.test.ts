import { afterEach, describe, expect, it, vi } from "vitest";
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
