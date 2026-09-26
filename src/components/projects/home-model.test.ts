import { describe, it, expect } from "vitest";
import {
  attentionRows,
  factsLine,
  homeStats,
  lastRunCell,
  lastRunLabel,
  otherMembershipNames,
} from "./home-model";
import type { MapOverview, TableListing } from "../api";
import type { WorkflowListing, WorkflowStep } from "../workflow-model";

/** The project home's pure derivations. */

const map = (over: Partial<MapOverview>) => ({ ...over }) as MapOverview;
const table = (over: Partial<TableListing>) => ({ ...over }) as TableListing;
const wf = (steps: Partial<WorkflowStep>[]) =>
  ({ steps }) as unknown as WorkflowListing;
const rel = (iso: string) => `~${iso}`;

describe("the stats line counts what the sections list", () => {
  it("counts members, published maps, and sums sizes honestly", () => {
    const stats = homeStats({
      maps: [map({ publishToken: "t" }), map({ publishToken: null })],
      workflows: [wf([])],
      tables: [table({ sizeBytes: 2048 }), table({ sizeBytes: 1024 })],
    });
    expect(stats).toEqual({
      maps: 2,
      workflows: 1,
      datasets: 2,
      published: 1,
      sizeLabel: "3 KB",
    });
  });

  it("marks the sum partial when a member size is unknown", () => {
    const stats = homeStats({
      maps: [],
      workflows: [],
      tables: [table({ sizeBytes: 2048 }), table({ sizeBytes: null })],
    });
    expect(stats.sizeLabel).toBe("≥ 2 KB");
  });
});

describe("other memberships name every project, never 'the first'", () => {
  const names = new Map([
    ["a", "Berlin"],
    ["b", "Atlas"],
  ]);

  it("names all others alphabetically and omits the home project", () => {
    expect(
      otherMembershipNames(table({ projectIds: ["home", "a", "b"] }), "home", names),
    ).toEqual(["Atlas", "Berlin"]);
  });

  it("omits an unknown name rather than inventing one", () => {
    expect(
      otherMembershipNames(table({ projectIds: ["home", "a", "ghost"] }), "home", names),
    ).toEqual(["Berlin"]);
  });
});

describe("the attention rows", () => {
  const listing = (over: Record<string, unknown>) =>
    ({
      id: "w1",
      name: "Lane density",
      steps: [],
      summary: { status: "up_to_date", count: 0 },
      ...over,
    }) as unknown as WorkflowListing;

  it("includes exactly the to-run-again workflows with the server's count", () => {
    const rows = attentionRows([
      listing({ id: "a", summary: { status: "run_again", count: 2 } }),
      listing({ id: "b", summary: { status: "up_to_date", count: 0 } }),
      listing({ id: "c", summary: { status: "failed", count: 1 } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(rows[0].count).toBe(2);
  });

  it("keeps several affected workflows as their own rows, ids and counts intact", () => {
    const rows = attentionRows([
      listing({ id: "a", name: "Lane density", summary: { status: "run_again", count: 2 } }),
      listing({ id: "b", name: "Commute hexes", summary: { status: "run_again", count: 1 } }),
      listing({ id: "c", summary: { status: "up_to_date", count: 0 } }),
    ]);
    expect(rows.map((r) => [r.id, r.name, r.count])).toEqual([
      ["a", "Lane density", 2],
      ["b", "Commute hexes", 1],
    ]);
  });

  it("names a stale cause truthfully and invents nothing without one", () => {
    const withCause = attentionRows([
      listing({
        summary: { status: "run_again", count: 1 },
        steps: [
          {
            causes: [{ reason: "input_changed", tableId: "t", tableName: "bike_lanes" }],
            conditions: ["stale"],
            proposedParameters: null,
          },
        ],
      }),
    ]);
    expect(withCause[0].cause).toBe("bike_lanes changed");

    const missing = attentionRows([
      listing({
        summary: { status: "run_again", count: 1 },
        steps: [
          { causes: [], conditions: ["output_missing"], proposedParameters: null },
        ],
      }),
    ]);
    expect(missing[0].cause).toBe("an output dataset was deleted");

    const edited = attentionRows([
      listing({
        summary: { status: "run_again", count: 1 },
        steps: [{ causes: [], conditions: [], proposedParameters: { x: 1 } }],
      }),
    ]);
    expect(edited[0].cause).toBe("an edit awaits a run");

    const silent = attentionRows([
      listing({ summary: { status: "run_again", count: 1 } }),
    ]);
    expect(silent[0].cause).toBeNull();
  });
});

describe("the workflow card's run fact", () => {
  it("names the newest recorded run whatever its outcome", () => {
    expect(lastRunLabel("2026-09-01T03:00:00Z", rel)).toBe(
      "ran ~2026-09-01T03:00:00Z",
    );
  });

  it("says Never run for no record, and the bare glyph for an unreadable history", () => {
    expect(lastRunLabel(null, rel)).toBe("Never run");
    expect(lastRunLabel("unreadable", rel)).toBe("—");
  });
});

describe("the facts line drops zeros", () => {
  const record = { createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" };
  it("shows only what exists, updated last, published only above zero", () => {
    const facts = factsLine(
      { maps: 2, workflows: 0, datasets: 3, published: 0, sizeLabel: "3 KB" },
      record,
      rel,
    );
    expect(facts.map((f) => f.key)).toEqual(["maps", "datasets", "size", "updated"]);
    expect(facts[0]).toEqual({ key: "maps", kind: "map", value: "2", label: "maps" });
    expect(facts[2]).toEqual({ key: "size", label: "3 KB" });
    expect(facts[3].label).toBe("updated ~2026-09-02T00:00:00Z");
  });
  it("adds published when above zero, keeps the partial size", () => {
    const facts = factsLine(
      { maps: 1, workflows: 1, datasets: 1, published: 1, sizeLabel: "≥ 2 KB" },
      record,
      rel,
    );
    expect(facts.map((f) => f.key)).toEqual(["maps", "workflows", "datasets", "published", "size", "updated"]);
    expect(facts[3]).toEqual({ key: "published", value: "1", label: "published" });
    expect(facts[4].label).toBe("≥ 2 KB");
    expect(facts[1].label).toBe("workflow");
  });
  it("an empty project says only when it was created", () => {
    expect(
      factsLine({ maps: 0, workflows: 0, datasets: 0, published: 0, sizeLabel: "0 B" }, record, rel),
    ).toEqual([{ key: "created", label: "created ~2026-09-01T00:00:00Z" }]);
  });
});

describe("the list's Last run cell", () => {
  it("is the bare time, never, or the glyph with its explanation", () => {
    expect(lastRunCell("2026-09-02T00:00:00Z", rel)).toEqual({ text: "~2026-09-02T00:00:00Z" });
    expect(lastRunCell(null, rel)).toEqual({ text: "never" });
    const unreadable = lastRunCell("unreadable", rel);
    expect(unreadable.text).toBe(lastRunLabel("unreadable", rel));
    expect(unreadable.title).toMatch(/couldn't be read/);
  });
});
