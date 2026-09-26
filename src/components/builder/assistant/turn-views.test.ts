import { describe, expect, it } from "vitest";
import { emptyTurn, type Turn } from "./assistant-turn-state";
import { liveTurnShown, turnViews } from "./turn-views";

/** One view per turn, keyed by its run: the
 * settled pairs, an assistant turn on its own, and the live turn. */
const entry = { id: "c1", tool: "run_sql", label: "Ran a query", status: "succeeded" as const, inputs: [], omitted: false };

describe("the turn views", () => {
  it("pairs a settled user turn with its assistant turn under the run's key, the record and answer on one view", () => {
    const turns: Turn[] = [
      { role: "user", text: "Count", runId: "r1", origin: { page: "builder" } },
      { role: "assistant", text: "Two.", runId: "r1", entries: [entry], origin: { page: "builder" } },
    ];
    expect(turnViews(turns, emptyTurn())).toEqual([
      { key: "r1", runId: "r1", message: "Count", origin: { page: "builder" }, text: "Two.", entries: [entry], pending: null, downloads: undefined, inserted: undefined, live: false },
    ]);
  });
  it("keeps a recovered assistant turn with no message as a view of its own, and the live turn under its run once reserved", () => {
    const turns: Turn[] = [{ role: "assistant", text: "Recovered.", runId: "r0" }];
    const live = { ...emptyTurn(), message: "Now", runId: "r2", text: "Str", actions: [entry] };
    const views = turnViews(turns, live);
    expect(views.map((v) => v.key)).toEqual(["r0", "r2"]);
    expect(views[1]).toMatchObject({ live: true, message: "Now", text: "Str", entries: [entry], pending: null });
  });
  it("gives the live turn the provisional key before a run is reserved, and no view when it holds nothing", () => {
    expect(turnViews([], { ...emptyTurn(), message: "Reserving" })[0].key).toBe("live");
    expect(turnViews([], emptyTurn())).toEqual([]);
    expect(liveTurnShown(emptyTurn())).toBe(false);
    expect(liveTurnShown({ ...emptyTurn(), pending: { id: "p", runId: "r", tool: "publish_map", args: {} } })).toBe(true);
  });
});
