import { describe, expect, it } from "vitest";
import { builderContext } from "./builder-context";

/** The builder's context carries its resolved theme, so an automatic check renders the appearance the person sees. */
describe("the builder supplies the appearance", () => {
  it("light and dark reach the context; the selected layer and map are unchanged", () => {
    expect(builderContext("m1", null, "dark")).toEqual({ page: "builder", mapId: "m1", selectedLayerId: null, appearance: "dark" });
    expect(builderContext("m1", "l1", "light")).toEqual({ page: "builder", mapId: "m1", selectedLayerId: "l1", appearance: "light" });
  });
});
