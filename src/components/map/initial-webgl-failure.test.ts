import { describe, expect, it, vi } from "vitest";
import { GPUInitializationError } from "maplibre-gl";
import {
  INITIAL_WEBGL_FAILURE_MESSAGE,
  attemptInitialWebGLMap,
  isInitialWebGLContextFailure,
} from "./initial-webgl-failure";

describe("initial WebGL context failure", () => {
  it("recognizes the installed renderer's public error without matching its wording", () => {
    const error = new GPUInitializationError({ antialias: false }, null);
    expect(isInitialWebGLContextFailure(error)).toBe(true);
    error.message = "The renderer changed its explanatory text";
    expect(isInitialWebGLContextFailure(error)).toBe(true);
  });

  it("does not classify unrelated startup or second-renderer failures", () => {
    for (const error of [
      new Error("The style is malformed"),
      new Error(new GPUInitializationError({}, null).message),
      Object.assign(new Error("GPU unavailable"), { name: "GPUInitializationError" }),
      new Error("Failed to create WebGL context: Your browser does not support WebGL"),
      new Error(JSON.stringify({ message: "Failed to initialize the renderer" })),
      "Failed to initialize WebGL",
    ]) {
      expect(isInitialWebGLContextFailure(error)).toBe(false);
    }
  });

  it("turns only the known failure into the stable user-facing state", () => {
    const start = vi.fn(() => {
      throw new GPUInitializationError({}, null);
    });
    expect(attemptInitialWebGLMap(start)).toEqual({
      ok: false,
      message: INITIAL_WEBGL_FAILURE_MESSAGE,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(INITIAL_WEBGL_FAILURE_MESSAGE).toMatch(/WebGL/);
    expect(INITIAL_WEBGL_FAILURE_MESSAGE).toMatch(
      /Reload|update|hardware acceleration/,
    );
  });

  it("returns a successful map and rethrows an unrelated error unchanged", () => {
    const map = { id: "map" };
    expect(attemptInitialWebGLMap(() => map)).toEqual({ ok: true, value: map });

    const unrelated = new Error("Unexpected renderer setup failure");
    expect(() =>
      attemptInitialWebGLMap(() => {
        throw unrelated;
      }),
    ).toThrow(unrelated);
  });
});
