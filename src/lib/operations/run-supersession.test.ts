import { expect, it, vi } from "vitest";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { editStep, reorderSteps, renameRecipe } from "@/lib/metadata/owned-recipes";
import { getTableByName } from "@/lib/metadata/tables";
import { executeQuery } from "@/lib/query/execute";
import { runBasisFixture } from "./run-basis-fixture";

const f = runBasisFixture();
const member = (run: Awaited<ReturnType<typeof f.settle>>, id: string) => run.members.find(m => m.stepId === id)!;

it.each(["parameters", "origins", "order", "edit and restore"] as const)("stops subsequent admission after same-clock %s while an admitted active output survives", async change => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  renameRecipe(f.scope(), f.id, "Same clock", undefined, f.basis());
  const before = f.facts(), original = f.step(f.first);
  const held = f.hold(), run = await f.start();
  try {
    await held.reached();
    if (change === "parameters") f.edit(f.second, 9);
    if (change === "origins") editStep(f.scope(), f.first, original.parameters, undefined, { captured: "changed" }, f.basis());
    if (change === "order") reorderSteps(f.scope(), f.id, [f.second, f.first], undefined, f.basis());
    if (change === "edit and restore") {
      f.edit(f.first, 9);
      editStep(f.scope(), f.first, original.parameters, undefined, original.origin, f.basis());
    }
    expect(f.facts().lastChangedAt).toBe(before.lastChangedAt);
    expect(f.facts().executableRevision).not.toBe(before.executableRevision);
  } finally { held.release(); }
  const done = await f.settle(run.id);
  expect(done.outcome).toBe("partly_completed");
  expect(member(done, f.first).state).toBe("succeeded");
  expect(member(done, f.second)).toMatchObject({ state: "failed", stoppedBy: "plan_changed", jobId: null });
  expect(getTableByName("first")).toMatchObject({ id: member(done, f.first).output!.id });
  expect((await executeQuery(f.scope(), "SELECT n FROM first")).preview).toEqual([{ n: 1 }]);
  expect(getTableByName("second")).toBeNull();
  expect(f.db().prepare("SELECT owner_id FROM data_tables WHERE name = 'first'").get()).toEqual({ owner_id: "runner" });
});

it.each(["newer parameters", "newer origin", "edit and restore"] as const)("protects a proposal and its previous artifact after %s during publication", async change => {
  expect((await f.settle((await f.start()).id)).outcome).toBe("completed");
  f.edit(f.first, 2);
  const admitted = f.step(f.first), oldTable = getTableByName("first")!;
  const files = await readdir(path.join(f.directory, "tables"));
  const held = f.hold(), run = await f.start();
  let accepted: ReturnType<typeof f.facts>, proposal: ReturnType<typeof f.step>;
  try {
    await held.reached();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(admitted.updatedAt));
    if (change === "newer parameters") f.edit(f.first, 3);
    if (change === "newer origin") editStep(f.scope(), f.first, admitted.proposedParameters!, undefined, { captured: "newer" }, f.basis());
    if (change === "edit and restore") { f.edit(f.first, 3); f.edit(f.first, 2); }
    accepted = f.facts(); proposal = f.step(f.first);
    expect(proposal.updatedAt).toBe(admitted.updatedAt);
  } finally { held.release(); }
  const done = await f.settle(run.id);
  expect(member(done, f.first)).toMatchObject({ state: "failed", stoppedBy: "operation_superseded", output: null });
  expect(member(done, f.second)).toMatchObject({ state: "not_run", jobId: null });
  expect(f.step(f.first)).toEqual(proposal!);
  expect(f.facts()).toEqual(accepted!);
  expect(getTableByName("first")).toEqual(oldTable);
  expect((await readdir(path.join(f.directory, "tables"))).sort()).toEqual(files.sort());
  expect((await executeQuery(f.scope(), "SELECT n FROM first")).preview).toEqual([{ n: 1 }]);
});
