import { EvaluationCancelled } from "@/lib/api/errors";
import { decodeVariant } from "./budget-variant";
import { decodeGeoJSON, geojsonProjection } from "./budget-geojson";
import { DuckDBListVector, DuckDBStructVector, JsonDuckDBValueConverter, type DuckDBConnection, type DuckDBVector } from "@duckdb/node-api";
import { budgetProjection, quoteIdent, type Projection } from "./budget-projection";
import { CellBudget, jsonBytes, type ResultBudget } from "./result-budget";

function decode(vector: DuckDBVector, index: number, projection: Projection, budget: CellBudget): unknown {
  if (projection.kind === "variant") return decodeVariant(vector, index, budget);
  if (projection.kind === "geojson") return decodeGeoJSON(vector, index, budget);
  if (projection.kind === "text") {
    const fields = vector as DuckDBStructVector;
    if (!fields.isItemValid(index)) { budget.take(4); return null; }
    budget.take(Number(fields.entryVectorAt(0).getItem(index)));
    return fields.entryVectorAt(1).getItem(index);
  }
  if (projection.kind === "list") {
    const cell = vector as DuckDBStructVector;
    if (!cell.isItemValid(index)) { budget.take(4); return null; }
    const list = cell.entryVectorAt(0) as DuckDBListVector;
    const count = list.getEntryLength(index);
    budget.take(2 + Math.max(0, count - 1));
    const offset = list.getEntryOffset(index);
    const result: unknown[] = [];
    for (let i = 0; i < count; i++) result.push(decode(list.childVector, offset + i, projection.children![0], budget));
    return result;
  }
  if (projection.kind === "struct" || projection.kind === "union") {
    const fields = vector as DuckDBStructVector;
    if (!fields.isItemValid(index)) { budget.take(4); return null; }
    if (projection.kind === "union") {
      const member = Number(fields.entryVectorAt(0).getItem(index));
      const tag = projection.names![member];
      budget.take(17 + jsonBytes(tag)); // {"tag":...,"value":...}
      return { tag, value: decode(fields.entryVectorAt(member + 1), index, projection.children![member], budget) };
    }
    const result: Record<string, unknown> = {};
    budget.take(2 + Math.max(0, projection.names!.length - 1));
    for (let i = 0; i < projection.names!.length; i++) {
      const name = projection.names![i];
      budget.take(jsonBytes(name) + 1);
      result[name] = decode(fields.entryVectorAt(i), index, projection.children![i], budget);
    }
    return result;
  }
  const value = JsonDuckDBValueConverter(vector.getItem(index), vector.type, JsonDuckDBValueConverter);
  budget.take(jsonBytes(value));
  return value;
}

/** Alternate returned row shapes still charge each decoded cell exactly once. */
export interface BudgetRowShape {
  rowBytes(index: number): number;
  keyBytes(name: string): number;
  geometryJSONColumns: ReadonlySet<string>;
}

/** The owning reader closes its connection on refusal; interrupt abandons the
 * current stream immediately, without draining another chunk. */
export async function readBudgetedRows(conn: DuckDBConnection, sql: string, budget: ResultBudget, geometryColumns: ReadonlySet<string> = new Set(), geometryJSON = false, interrupted: () => boolean = () => false, shape?: BudgetRowShape): Promise<Record<string, unknown>[]> {
  const prepared = await conn.prepare(sql);
  let projections: Projection[];
  let names: string[];
  try {
    names = Array.from({ length: prepared.columnCount }, (_, i) => prepared.columnName(i));
    projections = names.map((name, i) => (shape ? shape.geometryJSONColumns.has(name) : geometryJSON && geometryColumns.has(name))
      ? { sql: geojsonProjection(quoteIdent(name)), kind: "geojson" }
      : budgetProjection(quoteIdent(name), prepared.columnType(i)));
  } finally { prepared.destroySync(); }
  const query = `WITH __budget_values AS ${geometryJSON || shape?.geometryJSONColumns.size ? "" : "NOT "}MATERIALIZED (${sql}) SELECT ${projections.map((p, i) => `${p.sql} AS ${quoteIdent(names[i])}`).join(", ")} FROM __budget_values`;
  const rows: Record<string, unknown>[] = [];
  try {
    const result = await conn.stream(query);
    const keys = result.deduplicatedColumnNames();
    while (true) {
      if (interrupted()) throw new EvaluationCancelled();
      const chunk = await result.fetchChunk();
      if (interrupted()) throw new EvaluationCancelled();
      if (!chunk || chunk.rowCount === 0) break;
      for (let r = 0; r < chunk.rowCount; r++) {
        budget.take(shape ? shape.rowBytes(rows.length) : 2 + (rows.length ? 1 : 0) + Math.max(0, keys.length - 1));
        const row: Record<string, unknown> = {};
        for (let c = 0; c < keys.length; c++) {
          budget.take(shape ? shape.keyBytes(keys[c]) : jsonBytes(keys[c]) + 1);
          row[keys[c]] = decode(chunk.getColumnVector(c), r, projections[c], new CellBudget(budget, geometryColumns.has(names[c])));
        }
        rows.push(row);
      }
    }
    return rows;
  } catch (error) { conn.interrupt(); throw error; }
}
