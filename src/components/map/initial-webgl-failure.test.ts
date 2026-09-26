import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_WEBGL_FAILURE_MESSAGE,
  attemptInitialWebGLMap,
  isInitialWebGLContextFailure,
} from "./initial-webgl-failure";

describe("initial WebGL context failure", () => {
  it("recognizes both established MapLibre forms", () => {
    expect(
      isInitialWebGLContextFailure(new Error("Failed to initialize WebGL")),
    ).toBe(true);
    expect(
      isInitialWebGLContextFailure(
        new Error(
          JSON.stringify({
            message: "Failed to initialize WebGL",
            type: "webglcontextcreationerror",
            statusMessage: "GPU unavailable",
          }),
        ),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated startup or second-renderer failures", () => {
    for (const error of [
      new Error("The style is malformed"),
      new Error("Failed to create WebGL context: Your browser does not support WebGL"),
      new Error(JSON.stringify({ message: "Failed to initialize the renderer" })),
      "Failed to initialize WebGL",
    ]) {
      expect(isInitialWebGLContextFailure(error)).toBe(false);
    }
  });

  it("turns only the known failure into the stable user-facing state", () => {
    const start = vi.fn(() => {
      throw new Error("Failed to initialize WebGL");
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
