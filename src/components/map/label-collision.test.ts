import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNIT } from "@deck.gl/core";
import {
  LABEL_COLLISION_GROUP,
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

  it("keeps the ranking at the depth the collision map is drawn with: eight layers of ten thousand labels", () => {
    // The effect a label layer registers, and the depth it gives the map.
    type Effect = { id: string; createFBO(device: unknown, group: string): void };
    const effects: Effect[] = [];
    const layer = {
      getAttributeManager: () => ({ add: () => undefined }),
      context: { deck: { _addDefaultEffect: (e: Effect) => { if (!effects.some((x) => x.id === e.id)) effects.push(e); } } },
    };
    LabelCollisionExtension.prototype.initializeState.call(layer as never, {} as never, new LabelCollisionExtension());
    const formats: string[] = [];
    const device = {
      getDefaultCanvasContext: () => ({ canvas: { width: 8, height: 8 } }),
      createTexture: (props: { format: string }) => { formats.push(props.format); return {}; },
      createFramebuffer: (props: unknown) => props,
    };
    effects[0].createFBO(device, LABEL_COLLISION_GROUP);
    const depth = formats.find((format) => format.startsWith("depth"))!;
    const bits = ({ depth16unorm: 16, depth24plus: 24, "depth24plus-stencil8": 24, depth32float: 24 } as Record<string, number>)[depth];
    // A priority's place in that depth: z = -0.001 × priority, mapped to 0…1.
    const level = (priority: number) => Math.round((0.5 - 0.0005 * priority) * (2 ** bits - 1));
    // Every label, the top layer's first rank first, must lie strictly in
    // front of every label ranked below it.
    const count = 8;
    const cap = 10_000;
    const ties: string[] = [];
    let previous = -1;
    for (let place = count - 1; place >= 0; place -= 1) {
      for (let index = 0; index < cap; index += 1) {
        const at = level(collisionPriority(index, cap, { place, count }));
        if (at <= previous && ties.length < 3) ties.push(`layer ${place}, label ${index} (${depth})`);
        previous = at;
      }
    }
    expect(ties).toEqual([]);
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

  it("reads a label's box at points close enough that no label's space fits between them, and boundedly many", () => {
    // The grid the shader lays over a box, from its own constants: as many
    // points as keep them the spacing apart, up to the caps, each at the
    // middle of an equal cell.
    const constant = (name: string) => Number(new RegExp(`${name} = ([0-9.]+)`).exec(labelCollisionModule.vs)?.[1]);
    const spacing = constant("COLLISION_SPACING");
    const columns = constant("COLLISION_COLUMNS");
    const rows = constant("COLLISION_ROWS");
    const points = (extent: number, cap: number) => {
      const cells = Math.min(cap, Math.max(1, Math.ceil(extent / spacing)));
      return Array.from({ length: cells }, (_, i) => ((i + 0.5) * extent) / cells);
    };
    const reaches = (at: number[], from: number, to: number) => at.some((p) => p >= from && p <= to);
    // A centred box 384 pixels wide and a line tall: a space 4 pixels wide
    // and tall anywhere over it holds a point, its middle included.
    const across = points(384, columns);
    const down = points(16, rows);
    expect(reaches(across, 190, 194), "its middle").toBe(true);
    for (let x = 0; x + 4 <= 384; x += 1) expect(reaches(across, x, x + 4), `across at ${x}`).toBe(true);
    for (let y = 0; y + 4 <= 16; y += 1) expect(reaches(down, y, y + 4), `down at ${y}`).toBe(true);
    // So does every box up to 512 pixels wide and 32 tall.
    for (const extent of [8, 60, 200, 384, 512]) expect(Math.max(...points(extent, columns).map((p, i, all) => (i ? p - all[i - 1] : 2 * p)))).toBeLessThanOrEqual(4);
    for (const extent of [8, 16, 24, 32]) expect(Math.max(...points(extent, rows).map((p, i, all) => (i ? p - all[i - 1] : 2 * p)))).toBeLessThanOrEqual(4);
    // And no box asks for more than 1,024 points.
    expect(columns * rows).toBeLessThanOrEqual(1024);
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
