import { describe, expect, it } from "vitest";
import { classifyReference } from "./reference-forms";

/** The forms a written table name takes, as the engine binds it. */
describe("a table name's form", () => {
  it("reads another person's quoted mount name as that person's dataset in every local spelling", () => {
    const qualified = { form: "qualified", qualifier: "ada", name: "roads" };
    expect(classifyReference(["ada.roads"])).toEqual(qualified);
    expect(classifyReference(["main", "ada.roads"])).toEqual(qualified);
    expect(classifyReference(["MAIN", "Ada.Roads"])).toEqual(qualified);
    expect(classifyReference(["memory", "main", "ada.roads"])).toEqual(qualified);
    expect(classifyReference(["temp", "main", "ada.roads"])).toEqual(qualified);
  });

  it("keeps plain, qualified and engine names as they were", () => {
    expect(classifyReference(["roads"])).toEqual({ form: "plain", name: "roads" });
    expect(classifyReference(["main", "roads"])).toEqual({ form: "plain", name: "roads" });
    expect(classifyReference(["memory", "main", "roads"])).toEqual({ form: "plain", name: "roads" });
    expect(classifyReference(["ada", "roads"])).toEqual({ form: "qualified", qualifier: "ada", name: "roads" });
    // Too short to be a SQL name: not a mount name, so plain, as one part is.
    expect(classifyReference(["main", "x.parquet"])).toEqual({ form: "plain", name: "x.parquet" });
    expect(classifyReference(["x.parquet"])).toEqual({ form: "plain", name: "x.parquet" });
    expect(classifyReference(["information_schema", "tables"])).toEqual({ form: "engine" });
    expect(classifyReference(["memory", "information_schema", "tables"])).toEqual({ form: "engine" });
  });
});
