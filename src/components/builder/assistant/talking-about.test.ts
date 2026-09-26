import { describe, expect, it } from "vitest";
import { draftLines, formatAge, formatElapsed, talkingAbout } from "./talking-about";

/**
 * The chip row's rule: what the page shows, worded per subject, and
 * nothing without its subject. The agreement between the chips, the
 * captured message and the page's own state is the browser suite's; the words are held here.
 */

const NOW = Date.parse("2026-09-15T12:00:00Z");

describe("the builder's chips", () => {
  it("name the map, and the selected layer only with a selection", () => {
    expect(talkingAbout({ page: "builder", mapName: "Parks near stations", selectedLayerName: "parks" })).toEqual([
      { key: "map", label: "Map", value: "Parks near stations", icon: "map" },
      { key: "layer", label: "Layer", value: "parks", icon: "layer", mono: true },
    ]);
    expect(talkingAbout({ page: "builder", mapName: "Parks near stations", selectedLayerName: null }).map((c) => c.key)).toEqual(["map"]);
  });
});

describe("the /sql chips", () => {
  it("count the draft's lines and carry the edited mark exactly when the page shows it", () => {
    const edited = talkingAbout({ page: "sql", draft: "SELECT 1;\nSELECT 2;", edited: true, execution: null });
    expect(edited).toEqual([{ key: "draft", label: "Draft", value: "2 lines, edited", icon: "draft" }]);
    expect(talkingAbout({ page: "sql", draft: "SELECT 1;", edited: false, execution: null })[0].value).toBe("1 line");
    expect(talkingAbout({ page: "sql", draft: "  \n", edited: false, execution: null })[0].value).toBe("empty");
  });
  it("show no execution chip before a run, the rows and time after a success, the error in the failure tone after a failure", () => {
    expect(talkingAbout({ page: "sql", draft: "x", edited: false, execution: null })).toHaveLength(1);
    const success = talkingAbout({ page: "sql", draft: "x", edited: false, execution: { kind: "result", rows: 1204, elapsedMs: 812 } });
    expect(success[1]).toEqual({ key: "execution", label: "Last result", value: "1,204 rows · 0.8 s", icon: "result" });
    const failure = talkingAbout({ page: "sql", draft: "x", edited: false, execution: { kind: "error", message: 'column "geom" not found' } });
    expect(failure[1]).toEqual({ key: "execution", label: "Last run", value: 'Error: column "geom" not found', icon: "warn", tone: "bad" });
  });
  it("counts lines as the page does", () => {
    expect(draftLines("")).toBe(0);
    expect(draftLines("a\nb\nc\n")).toBe(3);
    expect(draftLines("a\nb\nc")).toBe(3);
  });
});

describe("the canvas chips", () => {
  it("name the workflow, the selected step only with one, and the run only once observed", () => {
    const none = talkingAbout({ page: "workflow", workflowName: "Parks near stations", selectedStepLabel: null, run: null });
    expect(none).toEqual([{ key: "workflow", label: "Workflow", value: "Parks near stations", icon: "flow" }]);
    const step = talkingAbout({ page: "workflow", workflowName: "W", selectedStepLabel: "Buffer 500 m", run: null });
    expect(step[1]).toEqual({ key: "step", label: "Node", value: "Buffer 500 m", icon: "node" });
  });
  it("read in progress while a run is observed running and its outcome and age once settled, failed in the failure tone", () => {
    const running = talkingAbout({ page: "workflow", workflowName: "W", selectedStepLabel: null, run: { kind: "running", startedAt: "2026-09-15T11:59:50Z" } }, NOW);
    expect(running[1]).toEqual({ key: "run", label: "Last run", value: "in progress", icon: "run" });
    const failed = talkingAbout({ page: "workflow", workflowName: "W", selectedStepLabel: null, run: { kind: "settled", outcome: "failed", finishedAt: "2026-09-15T11:58:00Z" } }, NOW);
    expect(failed[1]).toEqual({ key: "run", label: "Last run", value: "failed, 2 min ago", icon: "warn", tone: "bad" });
    const done = talkingAbout({ page: "workflow", workflowName: "W", selectedStepLabel: null, run: { kind: "settled", outcome: "completed", finishedAt: "2026-09-15T11:59:50Z" } }, NOW);
    expect(done[1]).toEqual({ key: "run", label: "Last run", value: "completed, just now", icon: "run" });
    expect(done[1].tone).toBeUndefined();
  });
});

describe("the words for time", () => {
  it("elapsed time in seconds with one decimal under a minute", () => {
    expect(formatElapsed(812)).toBe("0.8 s");
    expect(formatElapsed(12)).toBe("0.0 s");
    expect(formatElapsed(61_000)).toBe("61 s");
  });
  it("ages in minutes, hours and days", () => {
    expect(formatAge("2026-09-15T11:59:50Z", NOW)).toBe("just now");
    expect(formatAge("2026-09-15T11:58:00Z", NOW)).toBe("2 min ago");
    expect(formatAge("2026-09-15T09:00:00Z", NOW)).toBe("3 h ago");
    expect(formatAge("2026-09-13T12:00:00Z", NOW)).toBe("2 d ago");
    expect(formatAge("not a date", NOW)).toBe("");
  });
});
