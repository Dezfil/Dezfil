import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { dataDir } from "@/lib/config";
import {
  connectQueryInstance,
  hasQueryInstance,
  catalogGenerationOf,
} from "@/lib/duckdb";
import { listTables, type DataTable } from "@/lib/metadata/tables";
import { catalogBindings } from "./catalog-state";
import { artifactRelation } from "./artifact-relation";

/**
 * Register every uploaded table as a view, so user SQL sees names, not paths.
 * One implementation for every query path (SQL, layers, classification).
 *
 * Registration is serialized process-wide: connections share the hardened
 * instance's catalog, and concurrent CREATE OR REPLACE VIEW on the same name
 * is a DuckDB catalog write-write conflict — it surfaces as soon as a map
 * renders two layers in parallel. The queries themselves still run
 * concurrently; only the catalog writes queue.
 *
 * A pass writes only where the registry and the catalog's binding memory
 * disagree: each pass re-reads the registry inside its serialized turn and
 * compares per table, so the per-request cost follows what changed, not the
 * catalog's size. Where anything is uncertain — an unknown binding, a changed
 * identity or artifact, a failure — the pass does the work rather than
 * skipping it.
 */

let chain: Promise<unknown> = Promise.resolve();

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function registerTableViews(
  conn: DuckDBConnection,
  /** The boundary's abandonment probe: when it turns true,
   * this pass stops cleanly — no creates, and crucially no drops, since
   * an interrupt-induced failure says nothing about the shared view it
   * would tear out from under concurrent evaluations. */
  abandoned?: () => boolean,
  /** Materialization pins its catalog and evidence before this serialized
   * turn releases. Receives only views this pass successfully bound. */
  afterRegistration?: (registered: readonly DataTable[]) => Promise<void>,
): Promise<void> {
  const work = async () => {
    // The memory of the catalog THIS connection belongs to: a pass that
    // outlived a reset is handed an orphan map, so late work on a
    // discarded catalog cannot mark the replacement current.
    const bound = catalogBindings(catalogGenerationOf(conn));
    const tables = listTables();
    const registered: DataTable[] = [];
    // Reconciliation: drop views for names no longer registered — the
    // repair point for a delete whose own drop was lost. Registry-
    // driven, so unlike the degradation drop below it is always safe.
    const current = new Set(tables.map((t) => t.name));
    for (const name of [...bound.keys()]) {
      if (current.has(name)) continue;
      if (abandoned?.()) return;
      try {
        await conn.run(`DROP VIEW IF EXISTS ${ident(name)}`);
        bound.delete(name);
      } catch {
        if (abandoned?.()) return;
        // Left in the memory; the next pass retries.
      }
    }
    for (const t of tables) {
      if (abandoned?.()) return;
      // The skip: this exact binding — same identity, same artifact —
      // already succeeded into this catalog, so re-creating it would
      // change nothing. A refresh keeps the name and swaps the
      // artifact; a reclaimed name changes identity: both differ here
      // and re-register.
      const known = bound.get(t.name);
      if (
        known &&
        known.id === t.id &&
        known.file === t.file &&
        known.geometryColumn === t.geometryColumn
      ) {
        registered.push(t);
        continue;
      }
      const artifact = path.join(dataDir(), t.file);
      const relation = await artifactRelation(conn, artifact, t.geometryColumn);
      // **The probe can be interrupted too.** An evaluation that times out or
      // is abandoned rejects the schema read, and taking its failure as "no
      // geometry to normalise" would register a plain view and *remember* it —
      // leaving that table uncomparable until the catalog resets. So an
      // abandoned pass stops here, and an unprobed table registers usably but
      // is not recorded, so the next pass upgrades it.
      if (abandoned?.()) return;
      try {
        await conn.run(
          `CREATE OR REPLACE VIEW ${ident(t.name)} AS SELECT * FROM ${relation.from}`,
        );
        registered.push(t);
        if (relation.probed) {
          bound.set(t.name, {
            id: t.id,
            file: t.file,
            geometryColumn: t.geometryColumn,
          });
        } else bound.delete(t.name);
      } catch (error) {
        // An abandoned pass was interrupted by its own boundary — exit
        // without touching the catalog; the next evaluation re-registers.
        if (abandoned?.()) return;
        // A broken registration (e.g. its parquet artifact went missing)
        // must degrade to that one table failing when queried — never to
        // every query in the instance failing at registration. Only
        // success is remembered, so the next pass retries this table.
        await conn.run(`DROP VIEW IF EXISTS ${ident(t.name)}`).catch(() => {});
        bound.delete(t.name);
        console.warn(
          `table view "${t.name}" not registered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!abandoned?.()) await afterRegistration?.(registered);
  };
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Drop a deleted table's view from the shared catalog: without this, SQL
 * naming the deleted table fails with an engine file error exposing an
 * artifact path instead of the unknown-table answer a never-imported name
 * gets. Serialized on the same chain as registration, and ordered after
 * the registry row's removal, so a queued registration pass cannot
 * re-create what this drops. A catalog that was never created has nothing
 * to drop.
 */
export function dropTableView(name: string): Promise<void> {
  if (!hasQueryInstance()) return Promise.resolve();
  const work = async () => {
    const conn = await connectQueryInstance();
    try {
      await conn.run(`DROP VIEW IF EXISTS ${ident(name)}`);
      catalogBindings(catalogGenerationOf(conn)).delete(name);
    } finally {
      conn.disconnectSync();
    }
  };
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}
