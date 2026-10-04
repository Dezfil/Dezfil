import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { listReachableMaps } from "@/lib/metadata/map-queries";
import { requireReachable } from "./reach";
import { boundedEvaluation } from "@/lib/query/bounded";
import { resetQueryInstance } from "@/lib/duckdb";
import { executeQuery } from "@/lib/query/execute";
import { resolvePublication, requirePublicationScope } from "@/lib/publish/publication-scope";
import { resolvePublishedView } from "@/lib/publish/publication-resolution";
import { drainAccountWork } from "./account-deletion-admission";
import * as namespaces from "@/lib/query/namespace";
import * as relations from "@/lib/query/artifact-relation";
import type { PublishedView } from "@/lib/publish/publish-service";
const root = process.env.DEZFIL_DATA_DIR!; let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(root, "reads-")); process.env.DEZFIL_DATA_DIR = folder; closeMetadataDb(); resetQueryInstance(); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const target = testAccountScope(undefined, "target"), member = testAccountScope(undefined, "member"), control = testAccountScope(undefined, "control");
  shareProject("member", "shared", [["target", "editor"], ["control", "viewer"]]);
  const file = path.join(folder, "input.csv"); await writeFile(file, "value\n42\n");
  const data = await ingestFile(target, file, "data.csv");
  metadataDb().prepare("INSERT INTO project_datasets (project_id, table_id, added_at) VALUES (?, ?, '2026-10-04')").run("shared", data.id);
  const map = createMap(target, "Private sentinel");
  metadataDb().prepare("UPDATE maps SET project_id = 'shared', publish_token = 'target-link' WHERE id = ?").run(map.id);
  const own = createMap(control, "Control sentinel");
  metadataDb().prepare("UPDATE maps SET publish_token = 'control-link' WHERE id = ?").run(own.id);
  return { target, member, control, map, own };
}
it("fences new member and cached anonymous reads while earlier evaluations finish once and drain at their real end", async () => {
  const { member, control, map, own } = await fixture();
  const publication = resolvePublication("target-link")!;
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let completions = 0;
  const earlier = boundedEvaluation(async conn => {
    ready.resolve(); await release.promise;
    const rows = (await conn.runAndReadAll('SELECT * FROM "target.data"')).getRowObjects();
    completions++; return rows;
  }, { scope: member });
  await ready.promise;
  const view = { map: { id: map.id } } as unknown as PublishedView;
  await resolvePublishedView("target-link", Date.now(), async () => view);
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let drained = false; const draining = drainAccountWork("target").then(() => { drained = true; });
  try {
    await new Promise(r => setImmediate(r)); expect(drained).toBe(false);
    expect(() => requireReachable(member, "map", map.id)).toThrow();
    expect(listReachableMaps(member).some(m => m.map.id === map.id)).toBe(false);
    expect(() => requirePublicationScope(publication.scope)).toThrow();
    expect(await resolvePublishedView("target-link", Date.now(), async () => view)).toBeNull();
    await expect(executeQuery(member, 'SELECT * FROM "target.data"')).rejects.toThrow();
    expect(requireReachable(control, "map", own.id).id).toBe(own.id);
    expect(resolvePublication("control-link")).not.toBeNull();
  } finally { release.resolve(); }
  expect(await earlier).toHaveLength(1); await draining;
  expect(completions).toBe(1); expect(drained).toBe(true);
});
it("does not serve a publication scope or namespace captured before acceptance to new work", async () => {
  await fixture(); const scope = resolvePublication("target-link")!.scope;
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  await expect(executeQuery(scope, "SELECT 1")).rejects.toThrow();
});
it("holds an earlier anonymous assembly through its final read without retaining its late result", async () => {
  const { map } = await fixture();
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const view = { map: { id: map.id } } as unknown as PublishedView;
  const earlier = resolvePublishedView("target-link", Date.now(), async () => { ready.resolve(); await release.promise; return view; });
  await ready.promise;
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  await new Promise(r => setImmediate(r)); expect(done).toBe(false);
  release.resolve(); expect(await earlier).toBe(view); await drained;
  expect(await resolvePublishedView("target-link", Date.now(), async () => view)).toBeNull();
});

it("rejects late-discovered cached inputs before consuming their artifact", async () => {
  const { member } = await fixture();
  const independentMap = createMap(member, "Independent publication");
  metadataDb().prepare("UPDATE maps SET publish_token = 'member-link' WHERE id = ?").run(independentMap.id);
  const scope = resolvePublication("member-link")!.scope;
  const namespace = namespaces.namespaceFor(member);
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.spyOn(namespaces, "publicationNamespace").mockImplementation(async () => { ready.resolve(); await release.promise; return { namespace, withheld: false }; });
  const consume = vi.spyOn(relations, "artifactRelation");
  const pending = boundedEvaluation(async () => "read", { scope });
  const refused = expect(pending).rejects.toThrow();
  await ready.promise;
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  release.resolve(); await refused;
  expect(consume).not.toHaveBeenCalled();
});
