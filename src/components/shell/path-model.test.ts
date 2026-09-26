import { describe, it, expect } from "vitest";
import { browserTitle } from "./path-model";

/**
 * The reference's eight states, plus the several-projects and skipped-part rules. The
 * formatter is the one place the hierarchy exists, so these rows ARE
 * the contract.
 */

describe("the browser title (page 11's tab strips)", () => {
  const rows: [Parameters<typeof browserTitle>[0], string][] = [
    // Row 1: no project, instance unnamed.
    [{ name: "Stations map", section: "Maps" }, "Stations map · Dezfil"],
    // Row 2: in a project, unnamed instance.
    [
      { name: "Stations map", project: "Berlin mobility study", section: "Maps" },
      "Stations map · Berlin mobility study · Dezfil",
    ],
    // Row 3: instance named.
    [
      {
        name: "Stations map",
        project: "Berlin mobility study",
        section: "Maps",
        instance: "Stadtwerke",
      },
      "Stations map · Berlin mobility study · Stadtwerke",
    ],
    // Row 4: a list page.
    [{ section: "Maps", instance: "Stadtwerke" }, "Maps · Stadtwerke"],
    // Row 5: the project's own page (the project IS the name).
    [
      { name: "Berlin mobility study", instance: "Stadtwerke" },
      "Berlin mobility study · Stadtwerke",
    ],
    // Row 6: a workflow in the project.
    [
      {
        name: "Station catchments",
        project: "Berlin mobility study",
        section: "Workflows",
        instance: "Stadtwerke",
      },
      "Station catchments · Berlin mobility study · Stadtwerke",
    ],
    // Row 7: a table in the project.
    [
      {
        name: "stations",
        project: "Berlin mobility study",
        section: "Data Explorer",
        instance: "Stadtwerke",
      },
      "stations · Berlin mobility study · Stadtwerke",
    ],
    // A table in several projects titles without a project.
    [
      { name: "districts", section: "Data Explorer", instance: "Stadtwerke" },
      "districts · Stadtwerke",
    ],
    // Home.
    [{ section: "Home" }, "Home · Dezfil"],
    // Nothing at all still answers something.
    [{}, "Dezfil"],
  ];

  it("renders every reference state", () => {
    for (const [parts, expected] of rows) {
      expect(browserTitle(parts)).toBe(expected);
    }
  });

  it("object titles never repeat their section, and blanks never leave separators", () => {
    expect(browserTitle({ name: "X", section: "Maps" })).not.toContain("Maps");
    expect(browserTitle({ name: "X", project: "", instance: "  " })).toBe(
      "X · Dezfil",
    );
    expect(browserTitle({ section: "Maps", instance: "" })).toBe(
      "Maps · Dezfil",
    );
  });
});
