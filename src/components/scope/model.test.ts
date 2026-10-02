import { describe, it, expect } from "vitest";
import {
  activeRow,
  datasetProjectFact,
  headingLine,
  parseScope,
  printedCount,
  scopeParam,
  scopeRows,
  tileSubLine,
} from "./model";

/** The scope model. */

describe("address interpretation mirrors the listing vocabulary", () => {
  it("distinguishes missing, unfiled, named and empty-invalid", () => {
    expect(parseScope(null)).toEqual({ kind: "all" });
    expect(parseScope("none")).toEqual({ kind: "none" });
    expect(parseScope("p-1")).toEqual({ kind: "project", id: "p-1" });
    // Empty stays invalid: it is refused downstream, never widened.
    expect(parseScope("")).toEqual({ kind: "invalid" });
  });

  it("writes back the same vocabulary, removing the parameter for All", () => {
    expect(scopeParam({ kind: "all" })).toBeNull();
    expect(scopeParam({ kind: "none" })).toBe("none");
    expect(scopeParam({ kind: "project", id: "p-1" })).toBe("p-1");
  });
});

describe("the popover rows", () => {
  const projects = [
    { id: "a", name: "Berlin" },
    { id: "b", name: "Atlas" },
    { id: "c", name: "Empty shelf" },
  ];

  it("counts single-membership objects per project, zero-count projects included", () => {
    const rows = scopeRows(
      [{ p: "a" }, { p: "a" }, { p: "b" }, { p: null }],
      projects,
      (m: { p: string | null }) => (m.p ? [m.p] : []),
    );
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ["all", 4],
      ["a", 2],
      ["b", 1],
      ["c", 0],
      ["none", 1],
    ]);
  });

  it("counts a shared dataset in every membership and as unfiled only with none", () => {
    const rows = scopeRows(
      [{ ids: ["a", "b"] }, { ids: [] }],
      projects,
      (t: { ids: string[] }) => t.ids,
    );
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ["all", 2],
      ["a", 1],
      ["b", 1],
      ["c", 0],
      ["none", 1],
    ]);
  });

  it("membership order changes no count", () => {
    const forward = scopeRows([{ ids: ["a", "b"] }], projects, (t: { ids: string[] }) => t.ids);
    const reversed = scopeRows([{ ids: ["b", "a"] }], projects, (t: { ids: string[] }) => t.ids);
    expect(forward).toEqual(reversed);
  });

  it("the active row follows the scope and reads All when the world refuses", () => {
    const rows = scopeRows([], projects, () => []);
    expect(activeRow(rows, { kind: "none" }).id).toBe("none");
    expect(activeRow(rows, { kind: "project", id: "b" }).name).toBe("Atlas");
    expect(activeRow(rows, { kind: "project", id: "ghost" }).id).toBe("all");
    expect(activeRow(rows, { kind: "invalid" }).id).toBe("all");
  });

  it("with no rows yet the face reads All with NO count", () => {
    expect(activeRow([], { kind: "all" })).toEqual({
      id: "all",
      name: "All projects",
      count: null,
    });
  });
});

describe("what a row prints (behaviors 3 to 5)", () => {
  const projects = [
    { id: "a", name: "Berlin" },
    { id: "b", name: "Atlas" },
    { id: "c", name: "Empty shelf" },
  ];

  it("All projects prints nothing; every other row keeps its number, zero included", () => {
    const rows = scopeRows(
      [{ p: "a" }, { p: "a" }, { p: "b" }, { p: null }],
      projects,
      (m: { p: string | null }) => (m.p ? [m.p] : []),
    );
    expect(rows.map((r) => [r.id, printedCount(r)])).toEqual([
      ["all", null],
      // A named project, a second one, and a project at zero.
      ["a", 2],
      ["b", 1],
      ["c", 0],
      // Not in a project keeps its number too.
      ["none", 1],
    ]);
  });

  it("a project holding every item still prints its count: the rule reads identity, not value", () => {
    const rows = scopeRows(
      [{ p: "a" }, { p: "a" }, { p: "a" }],
      projects,
      (m: { p: string | null }) => (m.p ? [m.p] : []),
    );
    const all = rows.find((r) => r.id === "all")!;
    const berlin = rows.find((r) => r.id === "a")!;
    // One comparison, so a defect is proven against both halves: the two
    // counts are equal, and only the All row goes silent.
    expect({
      equal: berlin.count === all.count,
      all: printedCount(all),
      berlin: printedCount(berlin),
    }).toEqual({ equal: true, all: null, berlin: 3 });
  });

  it("the same rule answers for the face, whichever scope is active", () => {
    const rows = scopeRows(
      [{ p: "a" }, { p: null }],
      projects,
      (m: { p: string | null }) => (m.p ? [m.p] : []),
    );
    // Every scope in one comparison, so a defect is proven against each
    // rather than against whichever comes first.
    expect({
      all: printedCount(activeRow(rows, { kind: "all" })),
      named: printedCount(activeRow(rows, { kind: "project", id: "a" })),
      zero: printedCount(activeRow(rows, { kind: "project", id: "c" })),
      unfiled: printedCount(activeRow(rows, { kind: "none" })),
      // An unknown or refused scope reads as All, so it prints nothing.
      ghost: printedCount(activeRow(rows, { kind: "project", id: "ghost" })),
      invalid: printedCount(activeRow(rows, { kind: "invalid" })),
      // Before the world answers there are no rows and no count either.
      pending: printedCount(activeRow([], { kind: "all" })),
    }).toEqual({
      all: null,
      named: 1,
      zero: 0,
      unfiled: 1,
      ghost: null,
      invalid: null,
      pending: null,
    });
  });
});

describe("the heading's second line: only when it says something new", () => {
  const berlin = { kind: "project", id: "a" } as const;

  it("is silent when nothing narrows and nothing scopes", () => {
    expect(
      headingLine({ scopedTotal: 12, scope: { kind: "all" }, scopeName: null, shownCount: 12 }),
    ).toBeNull();
    expect(
      headingLine({ scopedTotal: 0, scope: { kind: "all" }, scopeName: null, shownCount: 0 }),
    ).toBeNull();
    // A refused scope renders no world; if it did, it would read as All.
    expect(
      headingLine({ scopedTotal: 3, scope: { kind: "invalid" }, scopeName: null, shownCount: 3 }),
    ).toBeNull();
  });

  it("says what is shown of what when a search or filter narrows, zero included", () => {
    expect(
      headingLine({ scopedTotal: 17, scope: { kind: "all" }, scopeName: null, shownCount: 4 }),
    ).toBe("4 of 17 shown");
    expect(
      headingLine({ scopedTotal: 17, scope: { kind: "all" }, scopeName: null, shownCount: 0 }),
    ).toBe("0 of 17 shown");
  });

  it("names the project, an empty one included", () => {
    expect(
      headingLine({ scopedTotal: 6, scope: berlin, scopeName: "Berlin", shownCount: 6 }),
    ).toBe("6 in Berlin");
    expect(
      headingLine({ scopedTotal: 0, scope: berlin, scopeName: "Berlin", shownCount: 0 }),
    ).toBe("0 in Berlin");
    expect(
      headingLine({ scopedTotal: 3, scope: { kind: "none" }, scopeName: null, shownCount: 3 }),
    ).toBe("3 not in a project");
    // A scope whose name has not resolved still names itself the way the
    // New tile does.
    expect(
      headingLine({ scopedTotal: 2, scope: berlin, scopeName: null, shownCount: 2 }),
    ).toBe("2 in this project");
  });

  it("composes a narrowing inside a scope, the reference's wording", () => {
    expect(
      headingLine({ scopedTotal: 6, scope: berlin, scopeName: "Berlin", shownCount: 1 }),
    ).toBe("1 of 6 in Berlin shown");
    expect(
      headingLine({ scopedTotal: 3, scope: { kind: "none" }, scopeName: null, shownCount: 1 }),
    ).toBe("1 of 3 not in a project shown");
  });
});

describe("the dataset Project cell", () => {
  const names = new Map([
    ["a", "Berlin"],
    ["b", "Atlas"],
  ]);

  it("lists every membership alphabetically outside a named scope", () => {
    expect(datasetProjectFact(["a", "b"], { kind: "all" }, names)).toEqual({
      text: "Atlas, Berlin",
      none: false,
    });
    expect(datasetProjectFact(["b", "a"], { kind: "all" }, names)).toEqual({
      text: "Atlas, Berlin",
      none: false,
    });
  });

  it("under a named scope names only the other memberships", () => {
    const scope = { kind: "project", id: "a" } as const;
    expect(datasetProjectFact(["a", "b"], scope, names).text).toBe(
      "also in Atlas",
    );
    expect(datasetProjectFact(["a"], scope, names).text).toBe("");
  });

  it("keeps a same-named sibling membership: identity is the id", () => {
    const dupes = new Map([
      ["a", "Berlin"],
      ["twin", "Berlin"],
    ]);
    expect(
      datasetProjectFact(["a", "twin"], { kind: "project", id: "a" }, dupes)
        .text,
    ).toBe("also in Berlin");
  });

  it("reads unfiled with no membership alone, and says a project the reader no longer reaches without naming it", () => {
    expect(datasetProjectFact([], { kind: "none" }, names)).toEqual({
      text: "not in a project",
      none: true,
    });
    // One's own dataset still filed in a project one was removed from: the
    // directory has no name for it, and it is not in no project.
    expect(
      datasetProjectFact(["ghost", "b"], { kind: "all" }, names).text,
    ).toBe("Atlas, a project you no longer reach");
    expect(datasetProjectFact(["ghost"], { kind: "all" }, names)).toEqual({
      text: "a project you no longer reach",
      none: false,
    });
    expect(
      datasetProjectFact(["ghost", "wraith"], { kind: "all" }, names).text,
    ).toBe("2 projects you no longer reach");
    expect(
      datasetProjectFact(["a", "ghost"], { kind: "project", id: "a" }, names)
        .text,
    ).toBe("also in a project you no longer reach");
  });
});

describe("the New/Add tile's scope sentence (the 12-A tile)", () => {
  it("keeps the shipped sentences for Maps and Workflows and gives Data the same forms", () => {
    expect(tileSubLine("map", { kind: "all" }, null)).toBe("Start from a blank map");
    expect(tileSubLine("workflow", { kind: "all" }, null)).toBe("Start from a blank canvas");
    expect(tileSubLine("data", { kind: "all" }, null)).toBe(
      "Upload a file or import from a source",
    );
    for (const kind of ["map", "workflow", "data"] as const) {
      expect(tileSubLine(kind, { kind: "none" }, null)).toBe("not in a project");
      expect(tileSubLine(kind, { kind: "project", id: "p" }, "Berlin")).toBe("in Berlin");
      expect(tileSubLine(kind, { kind: "project", id: "p" }, null)).toBe("in this project");
    }
    // An invalid scope is refused downstream; the tile keeps the unscoped sentence.
    expect(tileSubLine("data", { kind: "invalid" }, null)).toBe(
      "Upload a file or import from a source",
    );
  });
});
