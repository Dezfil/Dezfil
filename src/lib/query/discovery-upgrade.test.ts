import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer } from "@/lib/layer-service";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { startStepRun } from "@/lib/operations/step-execution";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { executeQuery } from "./execute";

/**
 * Catalogue discovery on a single-user store is what it was before the
 * engine learned to evaluate in a context. The fixture is the raw output of
 * the engine as it stood before that change, captured on this same store:
 * the catalogue functions, the information schema and the schema
 * inspection functions through the console, a layer whose SQL lists the
 * views, and a workflow step that records what it saw. The results now are
 * compared with it byte for byte.
 */
const FIXTURE = path.join(process.cwd(), "src/lib/query/fixtures/single-user-discovery.json");
type Entry = { label: string; sql: string; result: unknown };

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "discovery-upgrade-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
});
afterEach(async () => { await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

/** A result without its timing, the one field that is not the engine's answer. */
function withoutRuntime(result: Partial<Awaited<ReturnType<typeof executeQuery>>>): unknown {
  const copy = { ...result };
  delete copy.runtimeMs;
  return copy;
}

/** The same store, built the same way, read the same way as the capture. */
async function discover(entries: Entry[]): Promise<Entry[]> {
  const scope = testAccountScope();
  for (const [file, body] of [["roads.csv", "sentinel,lon,lat\nroad,13.4,52.5\n"], ["stats.csv", "name,value\nalpha,1\n"], ["group.csv", "sentinel,lon,lat\ngroup,13.3,52.4\n"]]) {
    const source = path.join(directory, file); await writeFile(source, body); await ingestFile(scope, source, file);
  }
  const captured: Entry[] = [];
  for (const { label, sql } of entries.filter((entry) => entry.label !== "layer render" && entry.label !== "workflow step")) {
    try {
      captured.push({ label, sql, result: withoutRuntime(await executeQuery(scope, sql)) });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      captured.push({ label, sql, result: { error: failure.code ?? null, message: failure.message ?? String(error) } });
    }
  }
  const map = createMap(scope, "Discovery");
  const layer = await createLayer(scope, map.id, { name: "Views", sql: "SELECT view_name, ST_Point(0, 0) AS geometry FROM duckdb_views() WHERE NOT internal ORDER BY view_name" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const render = await renderLayer(scope, layer);
  captured.push({ label: "layer render", sql: layer.sql, result: (render.geojson as { features: { properties: unknown }[] }).features.map(f => f.properties) });
  const recipe = createRecipe(scope, "Discovery");
  const one = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "stage_one" } });
  await startStepRun(scope, one.id); await laneSettled();
  const two = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT view_name FROM duckdb_views() WHERE NOT internal", name: "views_seen" } });
  await startStepRun(scope, two.id); await laneSettled();
  const seen = withoutRuntime(await executeQuery(scope, "SELECT view_name FROM views_seen ORDER BY view_name"));
  captured.push({ label: "workflow step", sql: "SELECT view_name FROM duckdb_views() WHERE NOT internal", result: seen });
  return captured;
}

it("returns the raw discovery results of a single-user store byte for byte as before", async () => {
  const before = await readFile(FIXTURE, "utf8");
  const entries = JSON.parse(before) as Entry[];
  expect(entries.map((entry) => entry.label)).toEqual([
    "views", "views bare", "tables", "columns", "engine columns", "engine tables", "schemas", "sqlite master",
    "pg views", "table info", "table info reserved", "show", "dynamic", "qualified", "layer render", "workflow step",
  ]);
  const now = JSON.stringify(await discover(entries), null, 2) + "\n";
  expect(now).toBe(before);
  // The comparison can fail: one more view anywhere is a different byte string.
  expect(now.replace('"view_name": "stats"', '"view_name": "test_account.stats"')).not.toBe(before);
}, 60_000);
