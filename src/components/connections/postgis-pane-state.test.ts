import { describe, expect, it } from "vitest";
import { connectionLoadDestination } from "./postgis-pane-state";

describe("PostGIS pane connection-list settlement", () => {
  it.each(["data_done", "layer_done"] as const)(
    "preserves %s when a host inventory update rerenders the pane",
    (current) => {
      expect(connectionLoadDestination(current, 1)).toBe("preserve");
    },
  );

  it("chooses the initial picker or form from connection truth", () => {
    expect(connectionLoadDestination("loading", 1)).toBe("pick");
    expect(connectionLoadDestination("loading", 0)).toBe("form");
  });
});
