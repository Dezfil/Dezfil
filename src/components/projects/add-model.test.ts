import { describe, it, expect } from "vitest";
import {
  actionLabel,
  distinctProducers,
  footer,
  resolveEnter,
  searchRows,
  dialogTitle,
  dialogTitleParts,
  membersFor,
  subjectCopy,
  type DependencyWire,
  type FilingSubject,
} from "./add-model";

/** The 14-A dialog's model. */

const dep = (
  id: string,
  producer: { id: string; name: string } | null = null,
): DependencyWire => ({
  id,
  name: id,
  source: "upload",
  rowCount: 1,
  projectIds: [],
  geometryColumn: "geometry",
  geometryType: "POINT",
  producer,
});

describe("distinct producers", () => {
  it("counts one workflow once across several checked outputs", () => {
    const wf = { id: "w1", name: "Catchments" };
    const deps = [dep("a", wf), dep("b", wf), dep("c")];
    expect(distinctProducers(deps, new Set(["a", "b", "c"]))).toEqual([wf]);
    expect(distinctProducers(deps, new Set(["c"]))).toEqual([]);
  });
});

describe("the live footer", () => {
  const wf = { id: "w1", name: "Catchments" };
  const deps = [dep("a", wf), dep("b", wf), dep("c")];
  const names = (id: string) => (id === "p1" ? "Berlin" : null);

  it("counts the map, datasets and distinct workflows; Map only with none", () => {
    const all = footer(
      deps,
      new Set(["a", "b", "c"]),
      { kind: "existing", id: "p1" },
      names,
    );
    expect(all.status).toBe("Map · 3 datasets · 1 workflow");
    expect(all.label).toBe("Add 5 items to Berlin");
    expect(all.enabled).toBe(true);
    const none = footer(deps, new Set(), { kind: "existing", id: "p1" }, names);
    expect(none.status).toBe("Map only");
    expect(none.label).toBe("Add 1 item to Berlin");
  });

  it("stays unavailable without a destination or an unnamed New", () => {
    expect(footer(deps, new Set(), null, names).enabled).toBe(false);
    const unnamed = footer(deps, new Set(), { kind: "new", name: "  " }, names);
    expect(unnamed.enabled).toBe(false);
    expect(unnamed.label).toBe("Add 1 item to a new project");
    const named = footer(
      deps,
      new Set(),
      { kind: "new", name: " Atlas " },
      names,
    );
    expect(named.enabled).toBe(true);
    expect(named.label).toBe("Add 1 item to Atlas");
    // The full contract gates: an over-bound name never enables a
    // confirmation the server would refuse.
    const over = footer(
      deps,
      new Set(),
      { kind: "new", name: "x".repeat(121) },
      names,
    );
    expect(over.enabled).toBe(false);
    expect(
      footer(deps, new Set(), { kind: "new", name: "x".repeat(120) }, names)
        .enabled,
    ).toBe(true);
  });
});

describe("the picker search and Enter", () => {
  const projects = [
    { id: "p1", name: "Berlin" },
    { id: "p2", name: "Berlin lanes" },
    { id: "p3", name: "Atlas" },
  ];

  it("keeps the picked row visible whatever is typed", () => {
    const { shown, hits } = searchRows(projects, "atl", "p1");
    expect(hits.map((h) => h.id)).toEqual(["p3"]);
    expect(shown.map((s) => s.id)).toEqual(["p1", "p3"]);
  });

  it("Enter picks one selectable hit, starts New on none, does nothing on several", () => {
    const all = () => true;
    expect(resolveEnter([{ id: "p3" }], "atl", all)).toEqual({
      kind: "pick",
      id: "p3",
    });
    expect(resolveEnter([], " Harbor ", all)).toEqual({
      kind: "new",
      name: "Harbor",
    });
    expect(resolveEnter([{ id: "p1" }, { id: "p2" }], "ber", all)).toBeNull();
    // The sole hit being unselectable (the current project) yields nothing.
    expect(
      resolveEnter([{ id: "p1" }], "berlin", (id) => id !== "p1"),
    ).toBeNull();
  });
});

describe("the opening action's wording", () => {
  it("reads adding unfiled and moving filed", () => {
    expect(actionLabel(null, false)).toBe("Add to a project");
    expect(actionLabel(null, true)).toBe("Move to another project");
  });
});

describe("the subject kinds", () => {
  const wf = { id: "wf", name: "Lane density" };
  const deps = [dep("a", wf), dep("b", wf), dep("c")];
  const all = new Set(["a", "b", "c"]);

  it("a map moves with its checked datasets and their producers, once", () => {
    expect(
      membersFor(
        { kind: "map", id: "m1", name: "M", projectId: null },
        deps,
        all,
      ),
    ).toEqual({
      addMaps: ["m1"],
      addTables: ["a", "b", "c"],
      addRecipes: ["wf"],
    });
    expect(
      footer(deps, all, { kind: "existing", id: "p" }, () => "Berlin", "map"),
    ).toEqual({
      status: "Map · 3 datasets · 1 workflow",
      label: "Add 5 items to Berlin",
      enabled: true,
    });
  });

  it("a workflow moves with its checked datasets only — never their producers", () => {
    expect(
      membersFor(
        { kind: "workflow", id: "wf", name: "W", projectId: "p0" },
        deps,
        new Set(["a", "c"]),
      ),
    ).toEqual({
      addRecipes: ["wf"],
      addTables: ["a", "c"],
    });
    expect(
      footer(
        deps,
        new Set(["a", "c"]),
        { kind: "existing", id: "p" },
        () => "Berlin",
        "workflow",
      ),
    ).toEqual({
      status: "Workflow · 2 datasets",
      label: "Add 3 items to Berlin",
      enabled: true,
    });
    expect(footer(deps, new Set(), null, () => null, "workflow").status).toBe(
      "Workflow only",
    );
  });

  it("a dataset is added alone, and is never 'moved'", () => {
    const subject = {
      kind: "dataset" as const,
      id: "t1",
      name: "stations",
      projectIds: ["p0", "p1"],
    };
    expect(membersFor(subject, [], new Set())).toEqual({ addTables: ["t1"] });
    expect(
      footer(
        [],
        new Set(),
        { kind: "existing", id: "p" },
        () => "Berlin",
        "dataset",
      ),
    ).toEqual({
      status: "Dataset",
      label: "Add to Berlin",
      enabled: true,
    });
    expect(dialogTitle(subject)).toBe("Add stations to a project");
    expect(actionLabel("dataset", true)).toBe("Add to a project");
    expect(actionLabel("workflow", true)).toBe("Move to another project");
    expect(actionLabel("workflow", false)).toBe("Add to a project");
    expect(
      dialogTitle({ kind: "workflow", id: "w", name: "W", projectId: "p" }),
    ).toBe("Move W to another project");
  });
});

describe("the dialog's head", () => {
  it("splits the title around the subject's name, the same sentence", () => {
    const filed: FilingSubject = {
      kind: "map",
      id: "m",
      name: "Stations",
      projectId: "p",
    };
    expect(dialogTitleParts(filed)).toEqual({
      before: "Move ",
      name: "Stations",
      after: " to another project",
    });
    const loose: FilingSubject = {
      kind: "dataset",
      id: "t",
      name: "stations",
      projectIds: ["p"],
    };
    expect(dialogTitleParts(loose)).toEqual({
      before: "Add ",
      name: "stations",
      after: " to a project",
    });
    // The whole sentence, against literals (not the parts re-joined).
    expect(dialogTitle(filed)).toBe("Move Stations to another project");
    expect(dialogTitle(loose)).toBe("Add stations to a project");
  });

  it("keeps a line under the dataset dialog only", () => {
    expect(subjectCopy("map").subtitle).toBeNull();
    expect(subjectCopy("workflow").subtitle).toBeNull();
    expect(subjectCopy("dataset").subtitle).toBe(
      "A dataset can be in several projects. It stays in the ones it is in.",
    );
  });
});
