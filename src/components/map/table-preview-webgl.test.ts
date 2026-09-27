import { describe, expect, it, vi } from "vitest";
import { GPUInitializationError } from "maplibre-gl";
import { INITIAL_WEBGL_FAILURE_MESSAGE } from "./initial-webgl-failure";
import { attemptTablePreviewWebGLMap } from "./table-preview-webgl";

describe("table preview WebGL startup", () => {
  it("turns a construction failure into a local state and clears its canvas", () => {
    const host = { replaceChildren: vi.fn() };

    expect(
      attemptTablePreviewWebGLMap(host, () => {
        throw new GPUInitializationError({}, null);
      }),
    ).toEqual({ ok: false, message: INITIAL_WEBGL_FAILURE_MESSAGE });
    expect(host.replaceChildren).toHaveBeenCalledOnce();
  });

  it("returns a constructed map without clearing its host", () => {
    const host = { replaceChildren: vi.fn() };
    const map = { id: "preview" };

    expect(attemptTablePreviewWebGLMap(host, () => map)).toEqual({
      ok: true,
      value: map,
    });
    expect(host.replaceChildren).not.toHaveBeenCalled();
  });
});
