import type { Database } from "better-sqlite3";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { tableFromRow, type DataTable, type TableRow } from "@/lib/metadata/tables";
import { RESERVED_SQL_NAMES } from "@/lib/metadata/sql-names";
import { qualifiedNameParts } from "./qualified-name";
import { readOnlySql } from "./guard";
import { collectReferences, serializeSql, type TableReference } from "./references";

/**
 * The binding resolver: which dataset each table reference means.
 *
 * Every dataset reference in SQL or in a stored dataset parameter resolves to
 * a dataset identity, in a namespace of three things: the SQL home (the
 * account whose space plain names belong to), the datasets the evaluating
 * caller can reach, and the outputs a workflow declares. The rules:
 *
 *  - a plain name is the workflow's declared output of that name when there is
 *    one, even before it exists (a reserved, unavailable output then binds
 *    nothing and never falls back to a same-named dataset), else the home
 *    account's dataset of that name;
 *  - `<sql name>.<dataset>` is that person's dataset, external even when a
 *    declared output shares the name;
 *  - the engine's own qualified forms keep their meaning: `main.`, `temp.`,
 *    `memory.` and `memory.main.` name what a plain name names, and the
 *    engine's catalogues and schemas are not datasets at all.
 *
 * A name binds only when the caller can reach the dataset. What does not bind
 * is reported as written, never guessed: a qualified name outside reach is a
 * refusal, and a plain one is left to the engine, which also knows its own
 * relations by plain name.
 */

/** A dataset the caller can reach, with its owner's SQL name. */
export interface ReachableDataset extends DataTable {
  ownerId: string | null;
  ownerSqlName: string | null;
}

export interface Namespace {
  /** The SQL home: an account identity, never an authority. */
  home: { id: string | null; sqlName: string | null };
  /** Every dataset the evaluating caller can reach. */
  datasets: readonly ReachableDataset[];
  /** The workflow's declared outputs: a lower-cased name and the dataset
   * this reader binds for it, or null while it is unavailable. */
  outputs: ReadonlyMap<string, string | null>;
}

/** The registry's own record of a reachable dataset, without its owner. */
export function registryTable(dataset: ReachableDataset): DataTable {
  const table: Partial<ReachableDataset> = { ...dataset };
  delete table.ownerId;
  delete table.ownerSqlName;
  return table as DataTable;
}

/** The forms a written name can take. */
export type Classified =
  | { form: "plain"; name: string }
  | { form: "qualified"; qualifier: string; name: string }
  | { form: "engine" };

/** What a reference means in a namespace. */
export type Resolution =
  | { status: "bound"; dataset: ReachableDataset; output: boolean }
  /** A declared output this reader has no dataset for. */
  | { status: "reserved" }
  /** No dataset in reach. A plain name may still be one of the engine's own
   * relations; an external one never is. */
  | { status: "unbound"; external: boolean }
  /** The engine's catalogues and schemas. */
  | { status: "engine" };

const LOCAL = new Set(["main", "temp", "memory"]);
const ENGINE = new Set(RESERVED_SQL_NAMES.filter((name) => !LOCAL.has(name)));
const MOUNT_NAME = /^([a-z][a-z0-9_]{2,31})\.([a-z0-9_]+)$/;

/**
 * The form of a name, case-insensitively, as the engine would bind it. A
 * single identifier spelled like a qualified mount (`"ada.roads"`) is that
 * qualified name: no dataset name contains a dot.
 */
export function classifyReference(parts: readonly string[]): Classified {
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.length === 1) {
    const mount = MOUNT_NAME.exec(lower[0]);
    return mount ? { form: "qualified", qualifier: mount[1], name: mount[2] } : { form: "plain", name: lower[0] };
  }
  if (lower.length === 2) {
    if (LOCAL.has(lower[0])) return { form: "plain", name: lower[1] };
    if (ENGINE.has(lower[0])) return { form: "engine" };
    return { form: "qualified", qualifier: lower[0], name: lower[1] };
  }
  if (lower.length === 3 && (lower[0] === "memory" || lower[0] === "temp") && lower[1] === "main") {
    return { form: "plain", name: lower[2] };
  }
  return { form: "engine" };
}

/** A reference as a person would write it again, for a message. */
export function writtenReference(parts: readonly string[]): string {
  return parts.map((part) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `"${part.replace(/"/g, '""')}"`)).join(".");
}

function findDataset(namespace: Namespace, owner: (dataset: ReachableDataset) => boolean, name: string) {
  return namespace.datasets.find((dataset) => owner(dataset) && dataset.name.toLowerCase() === name);
}

export function resolveClassified(namespace: Namespace, classified: Classified): Resolution {
  if (classified.form === "engine") return { status: "engine" };
  if (classified.form === "plain") {
    if (namespace.outputs.has(classified.name)) {
      const id = namespace.outputs.get(classified.name);
      const dataset = id ? namespace.datasets.find((candidate) => candidate.id === id) : undefined;
      return dataset ? { status: "bound", dataset, output: true } : { status: "reserved" };
    }
    const dataset = findDataset(namespace, (candidate) => candidate.ownerId === namespace.home.id, classified.name);
    return dataset ? { status: "bound", dataset, output: false } : { status: "unbound", external: false };
  }
  const dataset = findDataset(namespace, (candidate) => candidate.ownerSqlName === classified.qualifier, classified.name);
  return dataset ? { status: "bound", dataset, output: false } : { status: "unbound", external: true };
}

export function resolveReference(namespace: Namespace, parts: readonly string[]): Resolution {
  return resolveClassified(namespace, classifyReference(parts));
}

/** A stored dataset parameter: a plain or qualified dataset name. */
export function resolveParameter(namespace: Namespace, value: string): { parts: string[]; resolution: Resolution } {
  const parts = qualifiedNameParts(value) ?? [value];
  return { parts, resolution: resolveReference(namespace, parts) };
}

/** The refusal for a dataset reference that does not resolve within reach.
 * It repeats the reference as written and confirms nothing about whether the
 * dataset exists or whose it is. */
export function unavailableDataset(written: string): ApiError {
  return new ApiError("sql_error", `The dataset "${written}" is not available to you.`, 400);
}

export interface ResolvedRead {
  reference: TableReference;
  written: string;
  resolution: Resolution;
}

export interface ResolvedBindings {
  reads: ResolvedRead[];
  /** Each dataset the SQL binds, once, in the order it is first referenced. */
  datasets: ReachableDataset[];
  /** Of those, the identities whose geometry the SQL references. A star
   * projection carries every input's geometry; an unqualified geometry
   * column is attributed to every input that has one. */
  geometry: Set<string>;
}

/**
 * Resolve every table reference of one statement: static references, dynamic
 * table-function arguments the engine can evaluate, and nested SQL. The
 * statement passes the read-only guard first, so dynamic targets are frozen as
 * the guard admitted them.
 */
export async function resolveSql(conn: DuckDBConnection, sql: string, namespace: Namespace): Promise<ResolvedBindings> {
  const admitted = await serializeSql(conn, await readOnlySql(conn, sql));
  const collected = await collectReferences(conn, admitted.statements ?? []);
  const reads = collected.references.map((reference) => ({
    reference,
    written: writtenReference(reference.parts),
    resolution: resolveReference(namespace, reference.parts),
  }));
  const datasets: ReachableDataset[] = [];
  for (const read of reads) {
    if (read.resolution.status === "bound" && !datasets.some((dataset) => dataset.id === (read.resolution as { dataset: ReachableDataset }).dataset.id)) {
      datasets.push(read.resolution.dataset);
    }
  }
  const datasetOf = new Map(reads.flatMap((read) => read.resolution.status === "bound" ? [[read.reference, read.resolution.dataset] as const] : []));
  const geometry = new Set<string>();
  for (const dataset of datasets) {
    const geom = dataset.geometryColumn?.toLowerCase();
    if (!geom) continue;
    const referenced = collected.starScopes || collected.columnRefs.some((ref) => {
      if (ref[ref.length - 1] !== geom) return false;
      if (ref.length === 1) return true;
      const owner = collected.aliases.get(ref[ref.length - 2]);
      return owner !== undefined && datasetOf.get(owner)?.id === dataset.id;
    });
    if (referenced) geometry.add(dataset.id);
  }
  return { reads, datasets, geometry };
}

/** The first reference that names a dataset outside reach, as written. */
export function firstExternalUnbound(bindings: ResolvedBindings): string | null {
  const read = bindings.reads.find((candidate) => candidate.resolution.status === "unbound" && candidate.resolution.external);
  return read ? read.written : null;
}

type ReachRow = TableRow & { owner_id: string | null; owner_sql_name: string | null };

/** The datasets behind a set of identities, with their owners' SQL names. */
export function reachableDatasets(ids: Iterable<string>, db: Database = metadataDb()): ReachableDataset[] {
  const rows = db.prepare(`SELECT t.*, a.sql_name AS owner_sql_name FROM data_tables t
    LEFT JOIN accounts a ON a.id = t.owner_id
    WHERE t.id IN (SELECT value FROM json_each(?))
    ORDER BY t.created_at DESC, t.name`).all(JSON.stringify([...ids])) as ReachRow[];
  return rows.map((row) => ({ ...tableFromRow(row), ownerId: row.owner_id, ownerSqlName: row.owner_sql_name }));
}

/** The datasets of a store no account has adopted yet. */
export function ownerlessDatasets(db: Database = metadataDb()): ReachableDataset[] {
  const rows = db.prepare("SELECT * FROM data_tables WHERE owner_id IS NULL ORDER BY created_at DESC, name").all() as TableRow[];
  return rows.map((row) => ({ ...tableFromRow(row), ownerId: null, ownerSqlName: null }));
}
