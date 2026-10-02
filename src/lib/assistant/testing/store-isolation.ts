import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { mkdir, rm } from "node:fs/promises";
import { allMaps, removeMap } from "@/lib/map-service";
import { listTablesWithSize, removeTable } from "@/lib/table-service";

/**
 * Test-owned: one scenario, one clean store (the measurement definition
 * of, "seeded on a clean instance"). A scripted run owns a private
 * directory and empties it whole; a live run shares its directory with a
 * standalone that keeps serving from it, so the rows and artifacts are
 * wiped through the same in-process repositories the seeds use and the
 * directory stays.
 */
export async function isolateScenario(input: { live: boolean; dir: string }): Promise<void> {
  if (!input.live) { await rm(input.dir, { recursive: true, force: true }); await mkdir(input.dir, { recursive: true }); return; }
  // The fixture account's maps (their layers go with them) and every dataset
  // removed through the repositories, rows and artifacts alike; the
  // directory itself stays, the standalone keeps serving from it.
  for (const map of allMaps(testAccountScope())) await removeMap(testAccountScope(), map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  for (const table of await listTablesWithSize(testAccountScope())) await removeTable(testAccountScope(), table.name);
}

/** What a seed would see: the maps and the tables the store holds. */
export async function storeContents(): Promise<{ maps: string[]; tables: string[] }> {
  return { maps: allMaps(testAccountScope()).map((m) => m.name), tables: (await listTablesWithSize(testAccountScope())).map((t) => t.name) };
}
export { removeMap, removeTable };
