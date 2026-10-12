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

import { picking, project, type Layer } from "@deck.gl/core";
import {
  CollisionFilterExtension,
  type CollisionFilterExtensionProps,
} from "@deck.gl/extensions";

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

/** A label layer's tag in the collision map's alpha: 1 to 255, never 0
 * (an empty spot), neighbouring layers always apart. */
export function collisionTag(stack: LabelStack): number {
  return (stack.place % 255) + 1;
}

const vs = /* glsl */ `\
in float collisionPriorities;

uniform sampler2D collision_texture;

layout(std140) uniform collisionUniforms {
  bool sort;
  bool enabled;
  float tag;
} collision;

float collision_fade = 1.0;

vec2 collision_getCoords(vec4 position) {
  vec4 collision_clipspace = project_common_position_to_clipspace(position);
  return (1.0 + collision_clipspace.xy / collision_clipspace.w) / 2.0;
}

// A label's identity in the collision map: its picking colour, its index in
// its own layer, and its layer's tag in the alpha.
float collision_match(vec2 tex, vec4 identity) {
  vec4 found = texture(collision_texture, tex);
  float delta = dot(abs(found - identity), vec4(1.0));
  return step(delta, 0.001);
}

float collision_isVisible(vec2 texCoords, vec4 identity) {
  if (!collision.enabled) {
    return 1.0;
  }
  // The share of a 5 by 5 window around the point that is still the label's.
  const int R = 2;
  float accumulator = 0.0;
  vec2 step = vec2(1.0 / project.viewportSize);
  vec2 delta = -float(R) * step;
  for (int i = -R; i <= R; i++) {
    delta.x = -step.x * float(R);
    for (int j = -R; j <= R; j++) {
      accumulator += collision_match(texCoords + delta, identity);
      delta.x += step.x;
    }
    delta.y += step.y;
  }
  float W = 2.0 * float(R) + 1.0;
  return pow(accumulator / (W * W), 2.2);
}
`;

const inject = {
  "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  if (collision.sort) {
    position.z = -0.001 * collisionPriorities * position.w;
  }
  if (collision.enabled) {
    vec4 collision_common_position = project_position(vec4(geometry.worldPosition, 1.0));
    vec2 collision_texCoords = collision_getCoords(collision_common_position);
    collision_fade = collision_isVisible(
      collision_texCoords,
      vec4(geometry.pickingColor / 255.0, collision.tag)
    );
    if (collision_fade < 0.0001) {
      position = vec4(0.0, 0.0, 2.0, 1.0);
    }
  }
  `,
  // After the picking module has set the picking colour: drawing the
  // collision map, the alpha of a footprint is its layer's tag.
  "vs:DECKGL_FILTER_COLOR": {
    order: 100,
    injection: /* glsl */ `
  color.a *= collision_fade;
  if (collision.sort && picking_vRGBcolor_Avalid.a > 0.0) {
    picking_vRGBcolor_Avalid.a = collision.tag;
  }
  `,
  },
};

interface CollisionModuleProps {
  enabled?: boolean;
  collisionFBO?: { colorAttachments: unknown[] };
  drawToCollisionMap?: boolean;
  dummyCollisionMap?: unknown;
  /** The label layer's own: its tag. */
  label?: { tag: number };
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
    uniforms.tag = opts.label.tag / 255;
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
  uniformTypes: { sort: "i32", enabled: "i32", tag: "f32" },
  defaultUniforms: { sort: false, enabled: false, tag: 1 / 255 },
};

export type LabelCollisionProps = CollisionFilterExtensionProps & {
  /** The layer's tag in the shared collision map. */
  collisionTag?: number;
};

/** deck's collision filter, with the shared map's identities. */
export class LabelCollisionExtension extends CollisionFilterExtension {
  static defaultProps = {
    ...CollisionFilterExtension.defaultProps,
    collisionTag: 1,
  };
  static extensionName = "LabelCollisionExtension";

  getShaders(this: Layer<LabelCollisionProps>) {
    return { modules: [labelCollisionModule] };
  }

  draw(this: Layer<LabelCollisionProps>, params: unknown) {
    CollisionFilterExtension.prototype.draw.call(this, params);
    this.setShaderModuleProps({
      collision: { label: { tag: this.props.collisionTag ?? 1 } },
    } as never);
  }
}
