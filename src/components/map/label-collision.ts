/*
 * One overlap test for every label on a map.
 *
 * Labels thin on the GPU: each label draws its footprint into a collision
 * map, the higher-ranked on top, and is then drawn only where the collision
 * map still holds its own footprint. The test used to run per layer, so the
 * labels of two layers over the same place printed on top of each other.
 * Every label layer now joins one collision map, and each takes a band of the
 * ranking by its place in the stack: an upper layer's labels outrank every
 * label of the layers below it, and inside a layer the label ranking decides
 * as before.
 *
 * A footprint in the collision map is a label's picking colour, which is only
 * its index inside its own layer: the third label of one layer and the third
 * of another would read each other's footprint as their own. So each label
 * layer also carries a tag, written into the collision map's alpha beside the
 * colour, and a label owns a spot only where both match.
 *
 * A label is drawn whole or not at all. The test reads the label's own box,
 * as the text layer lays it out and draws it (its size, turn and offset), at
 * points spread over it a few pixels apart, and draws the label only if every
 * one of them is still its own. Two things it no longer does: look only around
 * the label's point, which a label beside its point does not cover and a label
 * above its point covers only on its edge, so such labels were culled or
 * faded with nothing near them; and turn the share of that look that was
 * clear into the label's opacity, so a label whose point sat near the edge of
 * a higher-ranked label's space, an edge the half-resolution collision map
 * puts on a two-pixel step, drew pale instead of whole or not at all. The
 * space a label claims is its box scaled by the layer's density (see
 * label-thinning.ts), so a label is drawn only where its whole box is clear
 * of every higher-ranked label's claim.
 *
 * The shader module adapts the collision filter of deck.gl
 * (@deck.gl/extensions, collision-filter/shader-module), whose notice
 * follows:
 *
 * Copyright Vis.gl contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import {
  LayerExtension,
  UNIT,
  picking,
  project,
  type CompositeLayer,
  type Layer,
  type LayerContext,
} from "@deck.gl/core";
import {
  CollisionFilterExtension,
  type CollisionFilterExtensionProps,
} from "@deck.gl/extensions";
import { TextLayer } from "@deck.gl/layers";
import type { LabelStyle } from "@/lib/style/style";

/** The one collision map every label on a map draws into. */
export const LABEL_COLLISION_GROUP = "labels";

/** A label layer's place among the map's label layers, the lowest first. */
export interface LabelStack {
  place: number;
  count: number;
}

/** A map whose labels come from one layer. */
export const SOLE_LABEL_LAYER: LabelStack = { place: 0, count: 1 };

/** Each label layer's place, from the map's label layers in draw order
 * (the lowest first, as the map stacks them). */
export function labelStacks(ids: readonly string[]): Map<string, LabelStack> {
  return new Map(ids.map((id, place) => [id, { place, count: ids.length }]));
}

/**
 * A label's rank in the shared test, inside the −1000…1000 the collision
 * map's depth carries. The range splits into one band per label layer, the
 * upper layers' above the lower; inside its band a layer's labels keep their
 * order (the data arrives ranked, the first label first). A margin at either
 * end of each band keeps neighbouring bands apart at the depth's resolution.
 */
export function collisionPriority(
  index: number,
  length: number,
  stack: LabelStack,
): number {
  const band = 2000 / Math.max(1, stack.count);
  const top = -1000 + band * (stack.place + 1);
  return top - band * (0.01 + (0.98 * index) / Math.max(1, length));
}

/** Whether a label layer's labels show anything on the map: the layer is
 * drawn at all, and its letters or its halo carry some ink. The collision
 * map holds a label's box whatever its paint, so a label nobody can see
 * would otherwise keep visible labels below it off the map. */
export function labelShows(
  label: Pick<LabelStyle, "color" | "haloWidth" | "haloColor">,
  opacity: number,
): boolean {
  const ink = label.color.a > 0;
  const halo = label.haloWidth > 0 && label.haloColor.a > 0;
  return opacity > 0 && (ink || halo);
}

/** A label layer's tag in the collision map's alpha: 1 to 255, never 0
 * (an empty spot), neighbouring layers always apart. */
export function collisionTag(stack: LabelStack): number {
  return (stack.place % 255) + 1;
}

const vs = /* glsl */ `\
in float collisionPriorities;
// The label's box beside its point, as the text layer lays it out: x, y,
// width, height, at the size its letters are cut at.
in vec4 collisionBoxes;

uniform sampler2D collision_texture;

layout(std140) uniform collisionUniforms {
  bool sort;
  bool enabled;
  float tag;
  float size;
  float sizeScale;
  int sizeUnits;
  float sizeMinPixels;
  float sizeMaxPixels;
  float fontSize;
  float angle;
  vec2 pixelOffset;
} collision;

// Points at most 4 pixels apart: any space at least that wide and tall that
// another label claims over the box holds one (the collision map resolves 2
// pixels on a plain screen, 1 on a dense one). A box up to 512 by 32 pixels
// keeps that spacing; a larger one spreads its 128 by 8 points, so no box is
// read at more than 1,024 points.
const int COLLISION_COLUMNS = 128;
const int COLLISION_ROWS = 8;
const float COLLISION_SPACING = 4.0;

// A label's identity in the collision map: its picking colour, its index in
// its own layer, and its layer's tag in the alpha.
bool collision_owns(vec2 tex, vec4 identity) {
  vec4 found = texture(collision_texture, tex);
  return dot(abs(found - identity), vec4(1.0)) < 0.001;
}

vec2 collision_rotate(vec2 vertex, float degrees) {
  float angle = radians(degrees);
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c) * vertex;
}

// Whether the collision map still holds the label all over its box, placed
// as the text layer places it about its point (anchor, in clip space).
bool collision_isVisible(vec4 anchor, vec4 identity) {
  float sizePixels = clamp(
    project_size_to_pixel(collision.size * collision.sizeScale, collision.sizeUnits),
    collision.sizeMinPixels, collision.sizeMaxPixels
  );
  float scale = sizePixels / collision.fontSize;
  vec2 origin = collisionBoxes.xy * scale;
  vec2 extent = collisionBoxes.zw * scale;
  vec2 cells = clamp(
    ceil(extent / COLLISION_SPACING),
    vec2(1.0),
    vec2(float(COLLISION_COLUMNS), float(COLLISION_ROWS))
  );
  // The collision map never draws its outermost texels: a point there, or
  // off the map, is contested by nothing.
  vec2 margin = 4.0 / project.viewportSize;
  for (int row = 0; row < COLLISION_ROWS; row++) {
    if (float(row) >= cells.y) break;
    for (int column = 0; column < COLLISION_COLUMNS; column++) {
      if (float(column) >= cells.x) break;
      vec2 inBox = origin + extent * (vec2(float(column), float(row)) + 0.5) / cells;
      vec2 pixels = collision_rotate(inBox, collision.angle) + collision.pixelOffset;
      pixels.y = -pixels.y;
      vec4 point = anchor;
      point.xy += project_pixel_size_to_clipspace(pixels);
      vec2 tex = (1.0 + point.xy / point.w) / 2.0;
      if (any(lessThan(tex, margin)) || any(greaterThan(tex, 1.0 - margin))) continue;
      if (!collision_owns(tex, identity)) return false;
    }
  }
  return true;
}
`;

const inject = {
  // Labels are billboards: the position handed here is the label's point.
  "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  if (collision.sort) {
    position.z = -0.001 * collisionPriorities * position.w;
  }
  if (collision.enabled
      && !collision_isVisible(position, vec4(geometry.pickingColor / 255.0, collision.tag))) {
    position = vec4(0.0, 0.0, 2.0, 1.0);
  }
  `,
  // After the picking module has set the picking colour: drawing the
  // collision map, the alpha of a footprint is its layer's tag.
  "vs:DECKGL_FILTER_COLOR": {
    order: 100,
    injection: /* glsl */ `
  if (collision.sort && picking_vRGBcolor_Avalid.a > 0.0) {
    picking_vRGBcolor_Avalid.a = collision.tag;
  }
  `,
  },
};

/** What the test needs of the label layer drawing: its tag, and how it
 * sizes, turns and offsets its labels. */
export interface LabelCollisionLayer {
  tag: number;
  size: number;
  sizeScale: number;
  sizeUnits: number;
  sizeMinPixels: number;
  sizeMaxPixels: number;
  fontSize: number;
  angle: number;
  pixelOffset: [number, number];
}

interface CollisionModuleProps {
  enabled?: boolean;
  collisionFBO?: { colorAttachments: unknown[] };
  drawToCollisionMap?: boolean;
  dummyCollisionMap?: unknown;
  label?: Partial<LabelCollisionLayer>;
}

/** The uniforms, from the collision effect's props (the map, and whether
 * this pass draws it) and from the label layer's own. */
export function labelCollisionUniforms(opts?: CollisionModuleProps) {
  const uniforms: Record<string, unknown> = {};
  if (opts && "dummyCollisionMap" in opts) {
    const { enabled, collisionFBO, drawToCollisionMap, dummyCollisionMap } = opts;
    uniforms.enabled = Boolean(enabled && !drawToCollisionMap);
    uniforms.sort = Boolean(drawToCollisionMap);
    uniforms.collision_texture =
      !drawToCollisionMap && collisionFBO
        ? collisionFBO.colorAttachments[0]
        : dummyCollisionMap;
  }
  if (opts?.label) {
    Object.assign(uniforms, opts.label);
    if (opts.label.tag !== undefined) uniforms.tag = opts.label.tag / 255;
  }
  return uniforms;
}

/** Named as deck's own module, so the collision effect's props reach it. */
export const labelCollisionModule = {
  name: "collision",
  dependencies: [project, picking],
  vs,
  inject,
  getUniforms: labelCollisionUniforms,
  uniformTypes: {
    sort: "i32",
    enabled: "i32",
    tag: "f32",
    size: "f32",
    sizeScale: "f32",
    sizeUnits: "i32",
    sizeMinPixels: "f32",
    sizeMaxPixels: "f32",
    fontSize: "f32",
    angle: "f32",
    pixelOffset: "vec2<f32>",
  },
  defaultUniforms: {
    sort: false,
    enabled: false,
    tag: 1 / 255,
    size: 0,
    sizeScale: 1,
    sizeUnits: UNIT.pixels,
    sizeMinPixels: 0,
    sizeMaxPixels: Number.MAX_SAFE_INTEGER,
    fontSize: 1,
    angle: 0,
    pixelOffset: [0, 0],
  },
};

export type LabelCollisionProps = CollisionFilterExtensionProps & {
  /** The layer's tag in the shared collision map. */
  collisionTag?: number;
  /** Each label's box beside its point; the text layer hands its own. */
  getCollisionBox?: unknown;
};

/** The props a label's sublayers draw with that the test reads. Label
 * layers size, turn and offset every label alike, so each is one value. */
interface LabelDrawProps {
  getSize?: unknown;
  getAngle?: unknown;
  getPixelOffset?: unknown;
  sizeScale?: number;
  sizeUnits?: keyof typeof UNIT;
  sizeMinPixels?: number;
  sizeMaxPixels?: number;
  fontSize?: number;
}

const one = (value: unknown, otherwise: number) =>
  typeof value === "number" ? value : otherwise;

/** deck's collision filter, with the shared map's identities, reading each
 * label's own box. */
export class LabelCollisionExtension extends CollisionFilterExtension {
  static defaultProps = {
    ...CollisionFilterExtension.defaultProps,
    collisionTag: 1,
    getCollisionBox: { type: "accessor", value: [0, 0, 0, 0] },
  };
  static extensionName = "LabelCollisionExtension";

  getShaders(this: Layer<LabelCollisionProps>) {
    return { modules: [labelCollisionModule] };
  }

  initializeState(this: Layer<LabelCollisionProps>, context: LayerContext, extension: this) {
    CollisionFilterExtension.prototype.initializeState.call(this, context, extension);
    const attributeManager = this.getAttributeManager();
    if (!attributeManager) return;
    attributeManager.add({
      collisionBoxes: { size: 4, stepMode: "dynamic", accessor: "getCollisionBox" },
    });
  }

  /** A text layer hands its letters and its box the layout it draws them
   * from, so the test reads the same box. */
  getSubLayerProps(this: CompositeLayer<LabelCollisionProps>, extension: this) {
    const props = LayerExtension.prototype.getSubLayerProps.call(this, extension);
    if (this instanceof TextLayer) {
      const triggers = this.props.updateTriggers as Record<string, unknown>;
      props.getCollisionBox = (this as unknown as { getBoundingRect: unknown }).getBoundingRect;
      props.updateTriggers.getCollisionBox = {
        getText: triggers.getText,
        getTextAnchor: triggers.getTextAnchor,
        getAlignmentBaseline: triggers.getAlignmentBaseline,
        styleVersion: (this.state as { styleVersion?: number } | undefined)?.styleVersion,
      };
    }
    return props;
  }

  draw(this: Layer<LabelCollisionProps>, params: unknown) {
    CollisionFilterExtension.prototype.draw.call(this, params);
    const props = this.props as LabelCollisionProps & LabelDrawProps;
    const offset = Array.isArray(props.getPixelOffset) ? props.getPixelOffset : [0, 0];
    const label: LabelCollisionLayer = {
      tag: props.collisionTag ?? 1,
      size: one(props.getSize, 0),
      sizeScale: props.sizeScale ?? 1,
      sizeUnits: UNIT[props.sizeUnits ?? "pixels"],
      sizeMinPixels: props.sizeMinPixels ?? 0,
      sizeMaxPixels: props.sizeMaxPixels ?? Number.MAX_SAFE_INTEGER,
      fontSize: props.fontSize ?? 1,
      angle: one(props.getAngle, 0),
      pixelOffset: [one(offset[0], 0), one(offset[1], 0)],
    };
    this.setShaderModuleProps({ collision: { label } } as never);
  }
}
