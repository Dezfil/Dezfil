import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { insertJob, type OperationJob } from "@/lib/metadata/jobs";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { captureAccountContent } from "@/lib/metadata/account-erasure-content";
import { shareProject } from "@/lib/test-support/sharing";
import { submit, laneEntriesForTests, laneSettled, resetLane } from "./lane";
import { startCascade, cascadeDriversForTests, cascadeSettled } from "./cascade";
import * as driver from "./cascade-driver";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "operation-work-erasure-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetLane(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetLane(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
it("drains captured owned lane work across graphs and preserves other initiators on surviving workflows", async () => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const workflow = createRecipe(control, "Same"), step = addStep(workflow.id, { operation: "sql_step", parameters: { sql: "SELECT 1", name: "out" } });
  const ids = ["target-running", "control-running", "target-waiting", "control-waiting"];
  for (const id of ids) {
    // The control-running job was initiated by target on someone else's workflow.
    const job: OperationJob = { id, subjectKind: id === "control-running" ? "step" : "run", subjectId: id === "control-running" ? step.id : id, operation: "sql_step", parameters: { secret: id }, state: "queued", errorCode: null, errorMessage: null, outputId: null, outputName: null, acceptedAt: "time", startedAt: null, finishedAt: null };
    insertJob(id === "control-waiting" ? control : target, job);
  }
  vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "2");
  const targetHold = Promise.withResolvers<void>(), controlHold = Promise.withResolvers<void>(); let targetSignal: AbortSignal | undefined, controlSignal: AbortSignal | undefined, queuedTargetRan = false;
  submit(ids[0], async signal => { targetSignal = signal; await targetHold.promise; }); submit(ids[1], async signal => { controlSignal = signal; await controlHold.promise; });
  submit(ids[2], async () => { queuedTargetRan = true; }); submit(ids[3], async () => { await controlHold.promise; });
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  const captured = metadataDb().transaction(() => captureAccountContent("target", metadataDb()))(); expect(captured.jobs).toEqual(["target-running", "target-waiting"]);
  const fields = ["inFlight", "waiting", "known"] as const, stores = Object.fromEntries(fields.map(f => { const id = `memory:src/lib/operations/lane.ts#${f}`; return [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]]; }));
  const probes = Object.fromEntries(fields.map(field => [`memory:src/lib/operations/lane.ts#${field}`, { populate() {}, dispose() {}, observe() { const entries = laneEntriesForTests()[field]; return { target: entries.filter(id => id.startsWith("target")), control: entries.filter(id => id.startsWith("control")) }; } }]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      vi.resetModules(); const other = await import("@/lib/assistant/account-erasure-work"); let done = false;
      const erased = other.eraseAccountWork("target", captured, metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false); expect(targetSignal?.aborted).toBe(true); expect(controlSignal?.aborted).toBe(false);
      // Keep the control queue stationary while observing each physical store.
      vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "1"); targetHold.resolve(); await erased; expect(queuedTargetRan).toBe(false);
    });
  } finally { targetHold.resolve(); controlHold.resolve(); await laneSettled(); }
});
it("drains owned cascade drivers while preserving foreign initiators and the named ownerless-run exception", async () => {
  const scopes = [testAccountScope(undefined, "target"), testAccountScope(undefined, "control")];
  shareProject("control", "p", [["target", "editor"]]);
  const recipes = [createRecipe(scopes[0], "Same"), createRecipe(scopes[1], "Same"), createRecipe(scopes[0], "Deleted earlier")];
  for (const recipe of recipes) { addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS n", name: "out" } }); metadataDb().prepare("UPDATE recipes SET project_id = 'p' WHERE id = ?").run(recipe.id); }
  const holds = recipes.map(() => Promise.withResolvers<void>()); let count = 0;
  vi.spyOn(driver, "driveCascade").mockImplementation(async () => { const hold = holds[count++]; await hold.promise; });
  const runs: Awaited<ReturnType<typeof startCascade>>[] = [];
  for (let i = 0; i < recipes.length; i++) runs.push(await startCascade(scopes[i === 0 ? 1 : 0], { recipeId: recipes[i].id, expectedRevision: readDocumentRevision({ kind: "workflow", id: recipes[i].id })!.editRevision }));
  metadataDb().prepare("DELETE FROM recipes WHERE id = ?").run(recipes[2].id);
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  const captured = metadataDb().transaction(() => captureAccountContent("target", metadataDb()))(); expect(captured.runs).toEqual([runs[0].id]);
  const id = "memory:src/lib/operations/cascade.ts#driving";
  try {
    await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, { [id]: { populate() {}, dispose() {}, observe() { const ids = cascadeDriversForTests(); return { target: ids.filter(id => id === runs[0].id), control: ids.filter(id => id !== runs[0].id) }; } } }, async () => {
      vi.resetModules(); const other = await import("@/lib/assistant/account-erasure-work"); let done = false;
      const erased = other.eraseAccountWork("target", captured, metadataDb()).then(() => { done = true; }); await new Promise(r => setImmediate(r)); expect(done).toBe(false);
      holds[0].resolve(); await erased;
    });
    // A workflow deleted earlier leaves no recoverable owner. Its run and held
    // driver are an explicit ownership-based exception, never silently swept.
    expect(metadataDb().prepare("SELECT id FROM cascade_runs WHERE id = ?").get(runs[2].id)).toEqual({ id: runs[2].id });
    expect(cascadeDriversForTests()).toEqual([runs[1].id, runs[2].id]);
  } finally { for (const hold of holds) hold.resolve(); await Promise.all(runs.map(run => cascadeSettled(run.id))); }
});
