import { blobDisplayText, stringByteLength } from "./budget-string";
import { DuckDBListVector, DuckDBStructVector, DuckDBVariantValue, DuckDBStructValue, VARIANT, JsonDuckDBValueConverter, type DuckDBVector } from "@duckdb/node-api";
import { jsonBytes, type CellBudget } from "./result-budget";

/** A variant's public getItem decodes its entire tree. Flatten containers in
 * the engine instead, retaining scalar type tags and lengths from that same
 * value. Only admitted scalar leaves cross the client boundary. */
export function variantProjection(expression: string): string {
  return `(WITH RECURSIVE walk(v, p, k) AS (
    SELECT ${expression}, []::BIGINT[], NULL::VARCHAR
    UNION ALL
    SELECT child.value, list_append(w.p, child.ordinality::BIGINT), child.key
    FROM walk w, LATERAL (
      SELECT e.entry.key, e.entry.value, e.ordinality
      FROM unnest(map_entries(CASE WHEN variant_typeof(w.v) LIKE 'OBJECT%' THEN CAST(w.v AS MAP(VARCHAR, VARIANT)) END)) WITH ORDINALITY e(entry, ordinality)
      UNION ALL
      SELECT NULL::VARCHAR, e.entry, e.ordinality
      FROM unnest(CASE WHEN variant_typeof(w.v) LIKE 'ARRAY%' THEN CAST(w.v AS VARIANT[]) END) WITH ORDINALITY e(entry, ordinality)
    ) child
  ), nodes AS (
    SELECT *, variant_typeof(v) AS t,
      CASE WHEN variant_typeof(v) LIKE 'OBJECT%' THEN 1 WHEN variant_typeof(v) LIKE 'ARRAY%' THEN 2 ELSE 0 END AS kind
    FROM walk
  ) SELECT list(struct_pack(
    kind := kind,
    children := CASE kind WHEN 1 THEN cardinality(CAST(v AS MAP(VARCHAR, VARIANT))) WHEN 2 THEN len(CAST(v AS VARIANT[])) ELSE 0 END,
    key_bytes := ${stringByteLength("k")}, key_value := k,
    bytes := CASE WHEN t IN ('VARCHAR', 'BIT', 'BIGNUM') THEN ${stringByteLength("CAST(v AS VARCHAR)")}
      WHEN t = 'BLOB' THEN ${stringByteLength(blobDisplayText("CAST(v AS BLOB)"))}
      WHEN t = 'GEOMETRY' THEN ${stringByteLength(blobDisplayText("ST_AsWKB(CAST(v AS GEOMETRY))"))} END,
    value := CASE WHEN kind = 0 THEN v END
  ) ORDER BY p) FROM nodes)`;
}

export function decodeVariant(vector: DuckDBVector, index: number, budget: CellBudget): unknown {
  const list = vector as DuckDBListVector;
  const nodes = list.childVector as DuckDBStructVector;
  let cursor = list.getEntryOffset(index);
  function next(nested: boolean): unknown {
    const row = cursor++;
    const kind = Number(nodes.entryVectorAt(0).getItem(row));
    if (kind) {
      const count = Number(nodes.entryVectorAt(1).getItem(row));
      budget.take(2 + Math.max(0, count - 1));
      if (kind === 2) {
        const result: unknown[] = [];
        for (let i = 0; i < count; i++) result.push(next(true));
        return result;
      }
      const result: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        budget.take(Number(nodes.entryVectorAt(2).getItem(cursor)) + 1);
        const key = nodes.entryVectorAt(3).getItem(cursor) as string;
        result[key] = next(true);
      }
      return result;
    }
    const bytes = nodes.entryVectorAt(4).getItem(row);
    if (bytes !== null) budget.take(Number(bytes));
    const variant = nodes.entryVectorAt(5).getItem(row) as DuckDBVariantValue | null;
    let value: unknown = null;
    if (variant) {
      // The client's existing container walker infers nested scalar types;
      // a top-level variant retains its explicit native type instead.
      value = nested
        ? (JsonDuckDBValueConverter(new DuckDBVariantValue(new DuckDBStructValue({ v: variant.value })), VARIANT, JsonDuckDBValueConverter) as { v: unknown }).v
        : JsonDuckDBValueConverter(variant, VARIANT, JsonDuckDBValueConverter);
    }
    if (bytes === null) budget.take(jsonBytes(value));
    return value;
  }
  return next(false);
}
