// The maplibre pole-clamp canary.
//
// The map canvas registers a constrain override on the map transform so
// the Mercator world stays flush with the canvas under asymmetric view
// padding (no page-background band past the poles). That hook —
// `setConstrainOverride` — is maplibre private API: nothing is wrong
// today, the clamp works and is load-bearing, but a maplibre bump could
// remove or stop honoring it without any suite noticing. This canary
// makes that failure loud and named at bump time.
//
// It checks the *installed* maplibre artifacts the app really ships:
//   1. the public typings still declare the hook (a removal or rename
//      turns red here, with this file naming the dependency);
//   2. the runtime implementation still stores the callback;
//   3. the constrain path still invokes the stored override — the
//      "present but no longer honored" breakage mode.
//
// A false alarm on an internal maplibre refactor is acceptable: a bump
// that touches this area must be looked at — that is the canary's job.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = dirname(require.resolve("maplibre-gl/package.json"));
const NAMED =
  "maplibre pole clamp: the private constrain-override hook the" +
  "map canvas relies on has changed in this maplibre version — the pole " +
  "clamp may be broken. Re-verify the clamp before taking this bump.";

/** The canary's assertions over one maplibre dist directory. */
function assertHook(dir: string): void {
  const dts = readFileSync(join(dir, "dist", "maplibre-gl.d.ts"), "utf8");
  expect(dts).toMatch(/setConstrainOverride\s*\(/);
  // The PRODUCTION bundle — the artifact the app actually ships — must
  // carry the setter, the store, and the invocation on the constrain
  // path (property names survive maplibre's minification; verified
  // against 5.24.0). A dev-only presence would be exactly the unhonored
  // mode this canary exists to catch.
  const js = readFileSync(join(dir, "dist", "maplibre-gl.js"), "utf8");
  expect(js).toContain("setConstrainOverride");
  expect(js).toMatch(/this\._constrainOverride\s*=/);
  expect(js).toContain("this._constrainOverride(");
  // The unminified dev bundle mirrors the same three facts readably.
  const dev = readFileSync(join(dir, "dist", "maplibre-gl-dev.js"), "utf8");
  expect(dev).toMatch(/this\._constrainOverride\s*=\s*constrain\b/);
  expect(dev).toMatch(/this\._constrainOverride\s*\(/);
}

describe("maplibre pole-clamp canary", () => {
  it(`the installed maplibre still carries the honored hook — ${NAMED}`, () => {
    assertHook(pkgDir);
  });

  it("demonstrably fails against a maplibre without the hook", () => {
    // A canary that cannot be shown red is not evidence: a doctored
    // artifact set with the hook removed must fail the same assertions.
    const doctored = mkdtempSync(join(tmpdir(), "dezfil-clamp-canary-"));
    try {
      mkdirSync(join(doctored, "dist"));
      writeFileSync(
        join(doctored, "dist", "maplibre-gl.d.ts"),
        "export declare class Map {}\n",
      );
      writeFileSync(
        join(doctored, "dist", "maplibre-gl.js"),
        "var maplibregl={};\n",
      );
      writeFileSync(
        join(doctored, "dist", "maplibre-gl-dev.js"),
        "var maplibregl = {};\n",
      );
      expect(() => assertHook(doctored)).toThrow();
    } finally {
      rmSync(doctored, { recursive: true, force: true });
    }
  });
});
