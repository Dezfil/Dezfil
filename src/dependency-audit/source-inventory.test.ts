import { describe, expect, it } from "vitest";
import { inspectSource, inventory } from "./source-inventory";

const GEO = "@deck.gl/geo-layers";
const OPAQUE_ACCESS_EXCEPTIONS: readonly { file: string; reason: string }[] = [
  {
    file: "src/lib/ingest/fixtures/receive-lifetime.mjs",
    reason: "Node-only test fixture loads busboy and the built bundle; its product sources are scanned directly.",
  },
];

function errorsNeedingReview(errors: string[]): string[] {
  return errors.filter((error) => !OPAQUE_ACCESS_EXCEPTIONS.some(({ file }) =>
    error === `${file}: opaque module access needs review`));
}

describe("MVT-only source inventory", () => {
  it("committed src inventory permits only the named MVTLayer imports", () => {
    const found = inventory("src");
    expect(found.files).toBeGreaterThan(200);
    expect(errorsNeedingReview(found.errors)).toEqual([]);
    expect(found.imports.sort()).toEqual([
      `src/components/map/tiled-layer.test.ts: ${GEO}#MVTLayer`,
      `src/components/map/tiled-layer.ts: ${GEO}#MVTLayer`,
    ]);
  }, 30_000);

  it("accepts reviewed opaque accesses in the named upload-lifetime fixture", () => {
    const found = inspectSource("src/lib/ingest/fixtures/receive-lifetime.mjs", "require(bundlePath);");
    expect(found.errors).toEqual([
      "src/lib/ingest/fixtures/receive-lifetime.mjs: opaque module access needs review",
    ]);
    expect(errorsNeedingReview(found.errors)).toEqual([]);
  });

  it.each([
    "src/lib/ingest/receive.ts",
    "src/lib/receive-lifetime.mjs",
    "src/lib/ingest/fixtures/second-lifetime.mjs",
    "src/lib/ingest/fixtures/receive-lifetime.mjs.ts",
  ])("keeps a seeded opaque access outside the named exception red: %s", (file) => {
    const found = inspectSource(file, "require(modulePath);");
    expect(errorsNeedingReview(found.errors)).toEqual([
      `${file}: opaque module access needs review`,
    ]);
  });

  it("still rejects a seeded restricted loader in the excepted fixture", () => {
    const file = "src/lib/ingest/fixtures/receive-lifetime.mjs";
    const found = inspectSource(file, `require(bundlePath); require("${GEO}");`);
    expect(errorsNeedingReview(found.errors)).toEqual([
      `${file}: restricted loader access: ${GEO}`,
    ]);
  });

  it.each([
    `import { MVTLayer } from "${GEO}";`,
    `import { MVTLayer as Tiles } from "${GEO}";`,
    `export { MVTLayer as Tiles } from "${GEO}";`,
    `import type { MVTLayer } from "${GEO}";`,
  ])("allows a named MVT symbol: %s", (source) => {
    expect(inspectSource("fixture.ts", source)).toEqual({
      imports: [`fixture.ts: ${GEO}#MVTLayer`], errors: [],
    });
  });

  it.each([
    `import { MVTLayer, Tile3DLayer } from "${GEO}";`,
    `import {\n MVTLayer,\n Tile3DLayer as MVT\n} from "${GEO}";`,
    `export { Tile3DLayer as MVTLayer } from "${GEO}";`,
    `import * as layers from "${GEO}";`,
    `export * from "${GEO}";`,
    `export * as layers from "${GEO}";`,
    `import MVTLayer from "${GEO}";`,
    `import "${GEO}";`,
    `import {} from "${GEO}";`,
    `const layers = await import("${GEO}");`,
    `const layers = require("${GEO}");`,
    `const layers = module.require("${GEO}");`,
    `require.resolve("${GEO}");`,
    `import layers = require("${GEO}");`,
    `type Layer = import("${GEO}").Tile3DLayer;`,
    `import MVTLayer from "${GEO}/dist/index.js";`,
    `import { Tile3DLayer } from "../../node_modules/${GEO}/dist/index.js";`,
    `import { ScenegraphLayer } from "@deck.gl/mesh-layers";`,
    `import { GLTFLoader } from "@loaders.gl/gltf";`,
    `export * from "@loaders.gl/textures";`,
    `import { load } from "@loaders.gl/3d-tiles";`,
    `import { load } from "@luma.gl/gltf";`,
    `import size from "image-size";`,
    `import { unzipSync } from "fflate";`,
    `import compress from "texture-compressor";`,
    `import { Tile3DLayer } from "deck.gl";`,
    `const module = "${GEO}"; import(module);`,
  ])("rejects a seeded widened or opaque import: %s", (source) => {
    expect(inspectSource("fixture.ts", source).errors.length).toBeGreaterThan(0);
  });

  it("ignores import-looking comments and fixture strings", () => {
    expect(inspectSource("fixture.ts", `// import * as all from "${GEO}";\nconst fixture = 'import * as all from "${GEO}"';`))
      .toEqual({ imports: [], errors: [] });
  });
});
