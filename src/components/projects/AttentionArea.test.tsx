import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { wire, type Wire } from "../workflow-canvas/fetch-wire";
import type { WorkflowRun } from "../workflow-canvas/run-overlay";
import type { WorkflowListing } from "../workflow-model";
import { AttentionArea, type AttentionRowView } from "./AttentionArea";
import { attentionRows } from "./home-model";

/**
 * The rows to run again. Bo's workflow Flow has two nodes to run again
 * because roads changed; Ada's workflow Survey has one, its output
 * dataset deleted. The project home draws each row with the sentence and
 * Run, and its runner reads the workflow's runs as it mounts. Another
 * host may ask for more: the owner's pill after the name on someone
 * else's workflow; Run withheld while the projects read that says who may
 * run it is pending (the pending line in Run's place) or failed (its
 * failure note with Try again); and quiet runners that read no runs,
 * which must still start a run after development's strict mode has
 * replayed their mount.
 */

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const step = (id: string, extra: object) => ({
  id, operation: "buffer", parameters: {}, conditions: [], causes: [], proposedParameters: null, output: null, ...extra,
});
const workflow = (id: string, name: string, owner: typeof ada, count: number, steps: object[]) =>
  ({
    id, name, owner, origin: "workflow", projectId: "p",
    summary: { nodes: steps.length, sources: 1, liveOutputs: 0, status: "run_again", count },
    steps,
  }) as unknown as WorkflowListing;
const WORKFLOWS = [
  workflow("w-bo", "Flow", bo, 2, [step("a", { causes: [{ tableName: "roads" }] }), step("b", {})]),
  workflow("w-ada", "Survey", ada, 1, [step("c", { conditions: ["output_missing"] })]),
];
const ROWS = attentionRows(WORKFLOWS);
const run: WorkflowRun = { id: "r", recipeId: "w-bo", kind: "single", outcome: null, cancelled: false, startedAt: "2026-10-02T15:00:00Z", finishedAt: null, members: [] };

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
let w: Wire;
const onChanged = vi.fn(async () => true);
beforeEach(() => {
  onChanged.mockClear();
  w = wire();
  vi.stubGlobal("fetch", w.fetch);
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const render = (rows: AttentionRowView[], options: { quiet?: boolean; strict?: boolean } = {}) =>
  act(async () => {
    const area = (
      <AttentionArea rows={rows} workflows={WORKFLOWS} opLabel={(op) => op} onChanged={onChanged} quiet={options.quiet} />
    );
    root.render(options.strict ? <StrictMode>{area}</StrictMode> : area);
  });
const settle = () => act(async () => { await w.settle(); });
const callout = (id: string) => container.querySelector(`[data-attention="${id}"]`)!;
const runOf = (id: string) => callout(id).querySelectorAll("button").find((b) => b.getAttribute("aria-label")?.startsWith("Run ")) ?? null;
const runsReads = () => w.calls.filter((c) => c.method === "GET" && /^\/api\/recipes\/[^/]+\/runs$/.test(c.path)).map((c) => c.path);

/** Run on a row whose plan is narrow: the plan, then the start, each answered. */
async function runNarrow(id: string) {
  await act(async () => runOf(id)!.click());
  await settle();
  w.pending("POST", `/api/recipes/${id}/runs`)[0]?.ok({ plan: { wide: false, kind: "run_all", members: ["a"] } });
  await settle();
  w.pending("POST", `/api/recipes/${id}/runs`)[0]?.ok({ run });
  await settle();
}

describe("the project home's rows to run again, as it draws them", () => {
  it("say the workflow, its count and its cause, and offer Run named for it", async () => {
    await render(ROWS);
    expect(callout("w-bo").querySelector("span")!.textContent).toBe("Flow has 2 nodes to run again: roads changed.");
    expect(callout("w-ada").querySelector("span")!.textContent).toBe("Survey has 1 node to run again: an output dataset was deleted.");
    expect(runOf("w-bo")!.textContent).toBe(" Run");
    expect(runOf("w-ada")!.getAttribute("aria-label")).toBe("Run Survey");
    expect(container.querySelectorAll("[data-owner-pill]")).toHaveLength(0);
    expect(container.querySelectorAll("[role=\"status\"]")).toHaveLength(0);
  });

  it("read each workflow's runs as the row mounts", async () => {
    await render(ROWS);
    expect(runsReads()).toEqual(["/api/recipes/w-bo/runs", "/api/recipes/w-ada/runs"]);
  });

  it("start a narrow run from Run under strict mode", async () => {
    await render(ROWS, { strict: true });
    await runNarrow("w-bo");
    expect(w.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ plan: true }, { members: ["a"] }]);
    expect(container.querySelectorAll("[role=\"alert\"]")).toHaveLength(0);
  });
});

describe("a row's options for another host", () => {
  it("wear the owner's pill right after the name on someone else's workflow", async () => {
    await render([ROWS[0], { ...ROWS[1], owner: ada }]);
    const sentence = callout("w-ada").querySelector("span")!;
    const [name, pill] = sentence.children;
    expect(name.textContent).toBe("Survey");
    expect(pill.getAttribute("data-owner-pill")).toBe("ada");
    expect(pill.getAttribute("aria-label")).toBe("Shared by Ada Okafor");
    expect(callout("w-bo").querySelectorAll("[data-owner-pill]")).toHaveLength(0);
    expect(runOf("w-ada")!.getAttribute("aria-label")).toBe("Run Survey");
  });

  it("withhold Run while the projects read is pending, with the pending line in its place", async () => {
    await render([ROWS[0], { ...ROWS[1], owner: ada, withheld: { status: "pending" } }]);
    expect(runOf("w-ada")).toBeNull();
    expect(callout("w-ada").querySelectorAll("button")).toHaveLength(0);
    const line = callout("w-ada").querySelector("[role=\"status\"]");
    expect(line?.textContent).toBe("Reading your projects…");
    expect(runOf("w-bo")!.getAttribute("aria-label")).toBe("Run Flow");
  });

  it("say the projects read's failure with Try again in Run's place, and Try again asks again", async () => {
    const retry = vi.fn();
    const failure = "Couldn't reach the server to load the projects.";
    await render([ROWS[0], { ...ROWS[1], owner: ada, withheld: { status: "failed", error: failure, retry } }]);
    expect(runOf("w-ada")).toBeNull();
    const note = callout("w-ada").querySelector("[role=\"alert\"]")!;
    expect(note.querySelector("p")!.textContent).toBe(failure);
    const again = note.querySelectorAll("button").find((b) => b.textContent === "Try again")!;
    await act(async () => again.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(runOf("w-bo")!.getAttribute("aria-label")).toBe("Run Flow");
  });

  it("with quiet runners, read no workflow's runs", async () => {
    await render([ROWS[0], { ...ROWS[1], owner: ada, withheld: { status: "pending" } }], { quiet: true });
    await settle();
    expect(w.calls).toHaveLength(0);
  });

  it("with quiet runners under strict mode, still start a narrow run from Run", async () => {
    await render(ROWS, { quiet: true, strict: true });
    await runNarrow("w-bo");
    expect(container.querySelectorAll("[role=\"alert\"]").map((a) => a.textContent)).toEqual([]);
    expect(w.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ plan: true }, { members: ["a"] }]);
    expect(runsReads()).toEqual([]);
  });
});
