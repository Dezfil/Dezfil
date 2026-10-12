import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNIT } from "@deck.gl/core";
import {
  LabelCollisionExtension,
  collisionPriority,
  collisionTag,
  labelCollisionModule,
  labelCollisionUniforms,
} from "./label-collision";

describe("the shared overlap test's rules", () => {
  it("gives each layer of a stack its own band, the upper above the lower, none past deck's range", () => {
    const count = 3;
    const bands = [0, 1, 2].map((place) => {
      const stack = { place, count };
      return [collisionPriority(0, 500, stack), collisionPriority(499, 500, stack)];
    });
    for (let place = 1; place < count; place += 1) {
      expect(bands[place][1]).toBeGreaterThan(bands[place - 1][0]);
    }
    expect(bands[2][0]).toBeLessThan(1000);
    expect(bands[0][1]).toBeGreaterThan(-1000);
  });

  it("tags neighbouring layers apart and never as an empty spot", () => {
    const tags = Array.from({ length: 300 }, (_, place) => collisionTag({ place, count: 300 }));
    for (const [place, tag] of tags.entries()) {
      expect(tag).toBeGreaterThanOrEqual(1);
      expect(tag).toBeLessThanOrEqual(255);
      if (place > 0) expect(tag).not.toBe(tags[place - 1]);
    }
  });

  it("reads the collision map where the label is drawn, and draws it where the map is drawn", () => {
    const texture = { id: "map" };
    const dummy = { id: "dummy" };
    const drawn = labelCollisionUniforms({ enabled: true, collisionFBO: { colorAttachments: [texture] }, dummyCollisionMap: dummy });
    expect(drawn).toMatchObject({ enabled: true, sort: false, collision_texture: texture });
    const drawing = labelCollisionUniforms({ enabled: true, collisionFBO: { colorAttachments: [texture] }, drawToCollisionMap: true, dummyCollisionMap: dummy });
    expect(drawing).toMatchObject({ enabled: false, sort: true, collision_texture: dummy });
  });

  it("tests a label at the size, turn and offset it is drawn with", () => {
    const set: { collision: Parameters<typeof labelCollisionUniforms>[0] }[] = [];
    const layer = {
      props: {
        collisionTag: 3, getSize: 12, getAngle: 30, getPixelOffset: [12, -4],
        sizeScale: 1, sizeUnits: "meters", sizeMinPixels: 2, sizeMaxPixels: 48, fontSize: 64,
      },
      setShaderModuleProps: (props: (typeof set)[number]) => set.push(props),
    };
    LabelCollisionExtension.prototype.draw.call(layer as never, { shaderModuleProps: {} });
    expect(labelCollisionUniforms(set[0].collision)).toEqual({
      tag: 3 / 255, size: 12, angle: 30, pixelOffset: [12, -4],
      sizeScale: 1, sizeUnits: UNIT.meters, sizeMinPixels: 2, sizeMaxPixels: 48, fontSize: 64,
    });
  });

  it("draws a label whole or not at all: nothing scales its ink by how much of it is clear", () => {
    const injected = Object.values(labelCollisionModule.inject)
      .map((i) => (typeof i === "string" ? i : i.injection))
      .join("\n");
    expect(injected).not.toMatch(/color\.a\s*\*=/);
    expect(labelCollisionModule.vs).not.toMatch(/\bpow\(/);
  });

  it("carries deck.gl's notice, and NOTICE credits it", () => {
    const source = readFileSync("src/components/map/label-collision.ts", "utf8");
    expect(source).toContain("Copyright Vis.gl contributors.");
    expect(source).toContain("The above copyright notice and this permission notice shall be included in");
    const notice = readFileSync("NOTICE", "utf8");
    expect(notice).toMatch(/deck\.gl \(MIT, © vis\.gl contributors\)[\s\S]*?src\/components\/map\/label-collision\.ts/);
  });
});
