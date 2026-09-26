import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LayerDownloadControlProvider,
  useLayerDownloadPreparationTimeoutMs,
} from "./LayerDownloadControlProvider";

function TimeoutProbe() {
  return <span>{useLayerDownloadPreparationTimeoutMs()}</span>;
}

describe("LayerDownloadControlProvider", () => {
  it("carries the route-local preparation boundary", () => {
    const html = renderToStaticMarkup(
      <LayerDownloadControlProvider preparationTimeoutMs={90_000}>
        <TimeoutProbe />
      </LayerDownloadControlProvider>,
    );

    expect(html).toContain("90000");
  });

  it("fails closed when route wiring is missing", () => {
    expect(() => renderToStaticMarkup(<TimeoutProbe />)).toThrow(
      /must be used within LayerDownloadControlProvider/,
    );
  });
});
