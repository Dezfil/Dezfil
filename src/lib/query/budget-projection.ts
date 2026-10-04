import { blobDisplayText, stringByteLength } from "./budget-string";
import { variantProjection } from "./budget-variant";
import { DuckDBTypeId, type DuckDBType } from "@duckdb/node-api";

export const quoteIdent = (s: string): string => `"${s.replaceAll('"', '""')}"`;
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;
export type Projection = { sql: string; kind: "scalar" | "text" | "list" | "struct" | "union" | "geojson" | "variant"; children?: Projection[]; names?: readonly string[] };

/** Variable-sized leaves carry their serialized lengths in the same statement.
 * Containers stay native until the decoder visits each admitted child. No
 * private vector memory and no second evaluation of volatile expressions. */
export function budgetProjection(expression: string, type: DuckDBType, depth = 0): Projection {
  // Spatial aliases such as POINT_2D have STRUCT/LIST storage, but their
  // nominal SQL type does not bind struct_extract/list_transform directly.
  if (type.alias) {
    if (type.typeId === DuckDBTypeId.STRUCT) expression = `CAST(${expression} AS STRUCT(${type.entryNames.map((name, i) => `${quoteIdent(name)} ${type.entryTypes[i]}`).join(", ")}))`;
    if (type.typeId === DuckDBTypeId.LIST || type.typeId === DuckDBTypeId.ARRAY) expression = `CAST(${expression} AS ${type.valueType}[])`;
  }
  const child = `__dezfil_budget_item_${depth}`;
  const nullable = (sql: string) => `CASE WHEN ${expression} IS NULL THEN NULL ELSE ${sql} END`;
  switch (type.typeId) {
    case DuckDBTypeId.VARIANT: return { sql: variantProjection(expression), kind: "variant" };
    case DuckDBTypeId.LIST:
    case DuckDBTypeId.ARRAY: {
      const item = budgetProjection(child, type.valueType, depth + 1);
      return { sql: nullable(`struct_pack(items := list_transform(${expression}, ${child} -> ${item.sql}))`), kind: "list", children: [item] };
    }
    case DuckDBTypeId.STRUCT: {
      // The client's object conversion retains the last duplicate key in an
      // unnamed tuple. Discarded entries are not part of the returned cell.
      const indices = type.entryNames.map((_, i) => i).filter(i => type.entryNames.lastIndexOf(type.entryNames[i]) === i);
      const children = indices.map(i => budgetProjection(type.entryNames[i]
        ? `${expression}.${quoteIdent(type.entryNames[i])}` : `struct_extract(${expression}, ${i + 1})`, type.entryTypes[i], depth + 1));
      return { sql: nullable(`struct_pack(${children.map((p, i) => `v${i} := ${p.sql}`).join(", ")})`), kind: "struct", children, names: indices.map(i => type.entryNames[i]) };
    }
    case DuckDBTypeId.MAP: {
      const key = budgetProjection(`${child}.key`, type.keyType, depth + 1);
      const value = budgetProjection(`${child}.value`, type.valueType, depth + 1);
      return { sql: nullable(`struct_pack(items := list_transform(map_entries(${expression}), ${child} -> struct_pack(key := ${key.sql}, value := ${value.sql})))`), kind: "list", children: [{ sql: "", kind: "struct", names: ["key", "value"], children: [key, value] }] };
    }
    case DuckDBTypeId.UNION: {
      const children = type.memberTypes.map((t, i) => budgetProjection(`union_extract(${expression}, ${literal(type.memberTags[i])})`, t, depth + 1));
      return { sql: nullable(`struct_pack(tag := CASE union_tag(${expression}) ${type.memberTags.map((tag, i) => `WHEN ${literal(tag)} THEN ${i}`).join(" ")} END, ${children.map((p, i) => `v${i} := ${p.sql}`).join(", ")})`), kind: "union", children, names: type.memberTags };
    }
    case DuckDBTypeId.VARCHAR:
    case DuckDBTypeId.BLOB:
    case DuckDBTypeId.BIT:
    case DuckDBTypeId.BIGNUM:
    case DuckDBTypeId.ENUM:
    case DuckDBTypeId.GEOMETRY: {
      const text = type.typeId === DuckDBTypeId.GEOMETRY ? blobDisplayText(`ST_AsWKB(${expression})`)
        : type.typeId === DuckDBTypeId.BLOB ? blobDisplayText(expression) : `CAST(${expression} AS VARCHAR)`;
      return { sql: nullable(`struct_pack(bytes := ${stringByteLength(text)}, value := ${text})`), kind: "text" };
    }
    default: return { sql: expression, kind: "scalar" };
  }
}
