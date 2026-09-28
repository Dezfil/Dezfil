import { describe, expect, it } from "vitest";
import { INITIAL_WEBGL_FAILURE_MESSAGE } from "../../map/initial-webgl-failure";
import { renderMapImage, type RenderBrowser } from "@/lib/export/render-image";
import { initialDefinition } from "@/lib/export/image-definition";

describe("initial WebGL failure propagation", () => {
  it("carries the route failure through the existing render_failed contract", async () => {
    const definition = initialDefinition(
      {
        appearance: "light",
        camera: { lng: 13.4, lat: 52.5, zoom: 11 },
        canvasWidth: 1200,
        legendPresent: false,
        legendCorner: null,
        visibleWidgetIds: [],
        basemapLayers: null,
      },
      { width: 1920, scale: 1 },
    );
    const browser: RenderBrowser = {
      render: async () => ({ failed: INITIAL_WEBGL_FAILURE_MESSAGE }),
      close: async () => {},
      kill: () => {},
    };

    await expect(
      renderMapImage({
        mapId: "map-webgl-failure",
        definition,
        credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3000",
        driver: { launch: async () => browser },
      }),
    ).rejects.toMatchObject({
      code: "render_failed",
      message: INITIAL_WEBGL_FAILURE_MESSAGE,
    });
  });
});
