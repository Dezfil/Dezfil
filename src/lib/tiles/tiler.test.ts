import { afterEach, describe, expect, it } from "vitest";
import { tilerAvailable, tilerVersion, tippecanoePath } from "./tiler";

/**
 * Tiler capability probe. The dev/CI environment has tippecanoe installed —
 * the real binary answers the probe; a broken path degrades to unavailable
 * instead of throwing.
 */

afterEach(() => {
  delete process.env.DEZFIL_TIPPECANOE;
});

describe("tiler capability", () => {
  it("finds the real tippecanoe and reports its version", async () => {
    expect(await tilerAvailable()).toBe(true);
    expect(await tilerVersion()).toMatch(/tippecanoe/);
  });

  it("degrades to unavailable when the binary cannot run", async () => {
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    expect(tippecanoePath()).toBe("/nonexistent/tippecanoe");
    expect(await tilerAvailable()).toBe(false);
    expect(await tilerVersion()).toBeNull();
  });

  it("re-probes when the configured binary changes back", async () => {
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    expect(await tilerAvailable()).toBe(false);
    delete process.env.DEZFIL_TIPPECANOE;
    expect(await tilerAvailable()).toBe(true);
  });
});
