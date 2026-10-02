import { expect, it } from "vitest";
import { shareProject } from "@/lib/test-support/sharing";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { fileRecipe, deleteProject } from "@/lib/metadata/owned-projects";
import { editStep, renameRecipe } from "@/lib/metadata/owned-recipes";
import { transferWorkflow } from "@/lib/metadata/transfers";
import { getLayout } from "@/lib/metadata/recipe-layouts";
import { runnerOutput } from "@/lib/metadata/recipe-outputs";
import { isCancelled } from "@/lib/metadata/cascades";
import { POST as cancelRoute } from "@/app/api/recipes/[id]/runs/[runId]/cancel/route";
import { writeLayout } from "./recipe-layout";
import { runBasisFixture } from "./run-basis-fixture";

const f = runBasisFixture();
const standing = () => f.db().prepare("SELECT name, owner_id, home_account_id, project_id FROM recipes WHERE id = ?").get(f.id);
const files = (id: string) => f.db().prepare("SELECT project_id FROM project_datasets WHERE table_id = ? ORDER BY project_id").all(id);
const setupProject = () => {
  f.scope("host"); f.scope("editor");
  shareProject("host", "p", [["runner", "editor"], ["editor", "editor"]]);
  shareProject("host", "q", [["runner", "editor"], ["editor", "editor"]]);
};

it.each(["rename", "layout", "note", "filing", "unfiling", "dissolution", "transfer"] as const)("continues both promotions across %s and preserves the accepted non-definition change", async change => {
  expect((await f.settle((await f.start()).id)).outcome).toBe("completed");
  setupProject();
  if (change !== "filing") fileRecipe(f.scope(), f.id, "p", undefined, f.basis());
  const layout = { steps: { [f.first]: { x: 10, y: 20 } }, sources: {}, notes: [{ id: "note", x: 10, y: 30, w: 200, h: 120, color: "yellow", text: "Original note" }] };
  writeLayout(f.scope(), f.id, layout, undefined, f.basis());
  editStep(f.scope(), f.first, { sql: "SELECT 2 AS n, 'run_basis_hold' AS marker", name: "promoted_first" }, undefined, undefined, f.basis());
  editStep(f.scope(), f.second, { sql: "SELECT n + 3 AS n FROM promoted_first", name: "promoted_second" }, undefined, undefined, f.basis());
  const before = f.facts(), held = f.hold(), run = await f.start();
  let acceptedStanding: unknown, acceptedLayout: unknown, changed: ReturnType<typeof f.facts>;
  try {
    await held.reached();
    if (change === "rename") renameRecipe(f.scope("editor"), f.id, "Accepted name", undefined, f.basis());
    if (change === "layout") writeLayout(f.scope("editor"), f.id, { ...layout, steps: { [f.first]: { x: 90, y: 120 } } }, undefined, f.basis());
    if (change === "note") writeLayout(f.scope("editor"), f.id, { ...layout, notes: [{ ...layout.notes[0], text: "Accepted note" }] }, undefined, f.basis());
    if (change === "filing") fileRecipe(f.scope(), f.id, "q", undefined, f.basis());
    if (change === "unfiling") fileRecipe(f.scope(), f.id, null, undefined, f.basis());
    if (change === "dissolution") deleteProject(f.scope("host"), "p");
    if (change === "transfer") transferWorkflow(f.scope(), f.id, "editor", undefined, f.basis());
    changed = f.facts(); acceptedStanding = standing(); acceptedLayout = getLayout(f.id);
    expect(changed.editRevision).not.toBe(before.editRevision);
    expect(changed.executableRevision).toBe(before.executableRevision);
  } finally { held.release(); }
  const done = await f.settle(run.id);
  expect(done.outcome).toBe("completed");
  expect(done.members.every(m => m.state === "succeeded")).toBe(true);
  expect(f.step(f.first).parameters.sql).toContain("SELECT 2");
  expect(f.step(f.second).parameters.sql).toContain("n + 3");
  expect(f.step(f.first).proposedParameters).toBeNull();
  expect(f.step(f.second).proposedParameters).toBeNull();
  expect(f.facts().editRevision).not.toBe(changed!.editRevision);
  expect(f.facts().lastChangedBy).toBe("runner");
  expect(standing()).toEqual(acceptedStanding);
  expect(getLayout(f.id)).toEqual(acceptedLayout);
  const project = change === "filing" ? "q" : ["unfiling", "dissolution"].includes(change) ? null : "p";
  for (const m of done.members) {
    expect(f.db().prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(m.output!.id)).toEqual({ owner_id: "runner" });
    expect(files(m.output!.id)).toEqual(project ? [{ project_id: project }] : []);
  }
});

it.each(["demoted", "removed"] as const)("finishes admitted work privately when its editor is %s, with no promotion or further admission", async loss => {
  expect((await f.settle((await f.start()).id)).outcome).toBe("completed");
  setupProject(); fileRecipe(f.scope(), f.id, "p", undefined, f.basis()); f.edit(f.first, 2);
  const before = f.facts(), step = f.step(f.first), ownerOutput = runnerOutput(f.first, "runner");
  const held = f.hold(), run = await f.start("editor");
  try {
    await held.reached();
    if (loss === "demoted") f.db().exec("UPDATE project_people SET role = 'viewer' WHERE project_id = 'p' AND account_id = 'editor'");
    else f.db().exec("DELETE FROM project_people WHERE project_id = 'p' AND account_id = 'editor'");
  } finally { held.release(); }
  const done = await f.settle(run.id);
  expect(done.outcome).toBe("partly_completed");
  expect(done.members[0].state).toBe("succeeded");
  expect(done.members[1]).toMatchObject({ state: "failed", jobId: null, stoppedBy: loss === "demoted" ? "forbidden" : "not_found" });
  expect(f.step(f.first)).toEqual(step);
  expect(f.facts()).toEqual(before);
  expect(runnerOutput(f.first, "editor")).toBeNull();
  expect(runnerOutput(f.first, "runner")).toEqual(ownerOutput);
  expect(f.db().prepare("SELECT * FROM lineage_edges WHERE runner_id = 'editor'").all()).toEqual([]);
  expect(f.db().prepare("SELECT owner_id FROM data_tables WHERE id = ?").get(done.members[0].output!.id)).toEqual({ owner_id: "editor" });
  expect(files(done.members[0].output!.id)).toEqual([]);
});

it.each([false, true])("cancels without an edit revision, preserving outputs and facts; initiator out of reach: %s", async lost => {
  expect((await f.settle((await f.start()).id)).outcome).toBe("completed");
  setupProject(); fileRecipe(f.scope(), f.id, "p", undefined, f.basis());
  const before = f.facts(), outputs = f.db().prepare("SELECT * FROM data_tables ORDER BY id").all();
  const held = f.hold(), run = await f.start("editor");
  const call = (account: string) => cancelRoute(testAccountRequest(new Request(`http://instance.test/api/recipes/${f.id}/runs/${run.id}/cancel`, { method: "POST" }), undefined, account), { params: Promise.resolve({ id: f.id, runId: run.id }) });
  let response: Response;
  try {
    await held.reached();
    f.scope("outsider"); expect((await call("outsider")).status).toBe(404);
    if (lost) f.db().exec("DELETE FROM project_people WHERE project_id = 'p' AND account_id = 'editor'");
    const cancellation = call("editor");
    // The route crosses two async boundaries before raising its durable fence.
    for (let n = 0; n < 20 && !isCancelled(run.id); n++) await Promise.resolve();
    expect(isCancelled(run.id)).toBe(true);
    held.release(); response = await cancellation;
  } finally { held.release(); }
  const done = await f.settle(run.id);
  expect(done.outcome).toBe("cancelled");
  expect(done.members[1]).toMatchObject({ state: "not_run", jobId: null, stoppedBy: "cancelled" });
  expect(response!.status).toBe(lost ? 204 : 200);
  if (lost) expect(await response!.text()).toBe("");
  else expect((await response!.json()).run.outcome).toBe("cancelled");
  expect((await call("editor")).status).toBe(lost ? 204 : 200);
  expect(f.facts()).toEqual(before);
  expect(f.db().prepare("SELECT * FROM data_tables ORDER BY id").all()).toEqual(outputs);
});
