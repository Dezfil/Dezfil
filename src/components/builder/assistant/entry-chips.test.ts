import { describe, expect, it } from "vitest";
import { entryChips } from "./entry-chips";
import type { PageFacts } from "./talking-about";

const canvas = (over: Partial<Extract<PageFacts, { page: "workflow" }>> = {}): PageFacts =>
  ({ page: "workflow", workflowName: "W", selectedStepLabel: null, run: null, ...over });

describe("the entry chips", () => {
  it("Explain this node only with a step selected; Diagnose the last run only after an observed run", () => {
    expect(entryChips(canvas(), true)).toEqual([]);
    expect(entryChips(canvas({ selectedStepLabel: "Buffer 500 m" }), true).map((c) => c.label)).toEqual(["Explain this node"]);
    expect(entryChips(canvas({ run: { kind: "settled", outcome: "failed", finishedAt: "2026-09-15T00:00:00Z" } }), true).map((c) => c.label)).toEqual(["Diagnose the last run"]);
    expect(entryChips(canvas({ selectedStepLabel: "Buffer 500 m", run: { kind: "running", startedAt: "2026-09-15T00:00:00Z" } }), true).map((c) => c.label)).toEqual(["Explain this node", "Diagnose the last run"]);
  });
  it("leave once the transcript has a turn", () => {
    expect(entryChips(canvas({ selectedStepLabel: "Buffer 500 m" }), false)).toEqual([]);
  });
  it("stand on no other page", () => {
    expect(entryChips({ page: "builder", mapName: "M", selectedLayerName: "l" }, true)).toEqual([]);
    expect(entryChips({ page: "sql", draft: "", edited: false, execution: null }, true)).toEqual([]);
    expect(entryChips(undefined, true)).toEqual([]);
  });
});
