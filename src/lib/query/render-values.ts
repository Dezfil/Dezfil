import { DuckDBTypeId, type DuckDBListVector, type DuckDBStructVector, type DuckDBType, type DuckDBVector } from "@duckdb/node-api";
import { stringByteLength } from "./budget-string";
import { quoteIdent } from "./budget-projection";
import { jsonBytes, type ByteBudget } from "./result-budget";
import { setOwn } from "./set-own";

/**
 * Feature properties as a layer answer carries them: each value is what
 * JSON.parse makes of the engine's to_json text for it, so a number stays a
 * number at full width, a date stays its text, and a JSON document stays a
 * nested object, as layers have always drawn them. Unlike the SQL result
 * reader, nothing here caps a single value; the whole answer is bounded.
 *
 * Every value is decomposed in the engine so its serialized length is known
 * before it crosses into JavaScript: text carries its escaped length beside
 * it, lists and maps carry their member counts, and a JSON document is
 * walked node by node, its repeated member names resolved as JSON.parse
 * resolves them. Only numbers are converted first and counted after:
 * their JSON spelling is normalized by the parser (1.0 becomes 1), and each
 * is a short token. Integers, floating values and booleans are read as the
 * engine holds them: the engine writes a double's shortest exact spelling,
 * so the parsed text and the native value are the same number. The engine
 * runs no subquery inside a list function, and a document is walked by
 * one, so a list or map that holds a JSON document anywhere inside it reads
 * its items through a subquery over them instead: its documents are walked
 * like any other, and none is converted whole before it is counted.
 */
export type RenderValue =
  | { kind: "text" | "json" | "tree" | "number"; sql: string }
  | { kind: "list"; sql: string; item: RenderValue }
  | { kind: "struct"; sql: string; names: readonly string[]; fields: readonly RenderValue[] }
  | { kind: "map"; sql: string; value: RenderValue }
  | { kind: "union"; sql: string; tags: readonly string[]; members: readonly RenderValue[] };

/** A to_json text with its exact length when it is a JSON string, which the
 * parser and the serializer reproduce byte for byte. The other texts, the
 * spelling of a decimal or a wide integer, are short and counted once
 * parsed. */
function jsonText(expression: string): string {
  const text = `CAST(to_json(${expression}) AS VARCHAR)`;
  return `struct_pack(bytes := CASE WHEN starts_with(${text}, '"') THEN strlen(${text}) END, text := ${text})`;
}

/** A JSON document's nodes in document order, each with its parent, and
 * whether any object in it repeats a member name. Partitioning, grouping or
 * joining the nodes inside this per-value subquery keys that work by the
 * whole document, which exhausts the engine's memory on a document of a few
 * megabytes, so the engine only lists them. The decoder finds each node's
 * members by their parent, and only where a name repeats does it look over
 * an object's member names first: JSON.parse keeps the first position and
 * the last value, so the decoder reserves the first, reads the last and
 * skips the rest without converting them. */
function treeProjection(expression: string): string {
  return `(SELECT struct_pack(
      repeated := coalesce(count(n.key) > list_unique(list(hash(n.parent, n.key)) FILTER (WHERE n.key IS NOT NULL)), false),
      nodes := list(struct_pack(
        type := n.type,
        id := CAST(n.id AS DOUBLE),
        parent := CAST(n.parent AS DOUBLE),
        key_bytes := ${stringByteLength("n.key")},
        key := n.key,
        bytes := CASE WHEN n.type IN ('VARCHAR', 'BOOLEAN') THEN strlen(CAST(n.atom AS VARCHAR)) WHEN n.type = 'NULL' THEN 4 END,
        atom := CAST(n.atom AS VARCHAR)
      ) ORDER BY n.id))
    FROM json_tree(${expression}) AS n)`;
}

/** Whether a value of this type holds a JSON document anywhere inside it. */
function holdsJson(type: DuckDBType): boolean {
  if (type.typeId === DuckDBTypeId.VARCHAR) return type.alias === "JSON";
  switch (type.typeId) {
    case DuckDBTypeId.LIST:
    case DuckDBTypeId.ARRAY:
    case DuckDBTypeId.MAP:
      return holdsJson(type.valueType);
    case DuckDBTypeId.STRUCT:
      return type.entryTypes.some(holdsJson);
    case DuckDBTypeId.UNION:
      return type.memberTypes.some(holdsJson);
    default:
      return false;
  }
}

/** A list's items, each projected by `item` over `child`, in order, read
 * through a subquery rather than a list function so that a document among
 * them can be walked. An empty list stays empty. */
function walkedItems(list: string, child: string, depth: number, item: string): string {
  const place = `__dezfil_render_place_${depth}`;
  return `coalesce((SELECT list(${item} ORDER BY ${place}) FROM unnest(${list}) WITH ORDINALITY AS __dezfil_render_items_${depth}(${child}, ${place})), [])`;
}

export function renderValueProjection(expression: string, type: DuckDBType, depth = 0): RenderValue {
  const nullable = (sql: string) => `CASE WHEN ${expression} IS NULL THEN NULL ELSE ${sql} END`;
  if (type.typeId === DuckDBTypeId.VARCHAR && type.alias === "JSON") {
    return { kind: "tree", sql: nullable(treeProjection(expression)) };
  }
  // Spatial aliases such as POINT_2D have STRUCT/LIST storage, but their
  // nominal SQL type does not bind struct_extract/list_transform directly.
  if (type.alias) {
    if (type.typeId === DuckDBTypeId.STRUCT) expression = `CAST(${expression} AS STRUCT(${type.entryNames.map((name, i) => `${quoteIdent(name)} ${type.entryTypes[i]}`).join(", ")}))`;
    if (type.typeId === DuckDBTypeId.LIST || type.typeId === DuckDBTypeId.ARRAY) expression = `CAST(${expression} AS ${type.valueType}[])`;
  }
  const child = `__dezfil_render_item_${depth}`;
  switch (type.typeId) {
    case DuckDBTypeId.LIST:
    case DuckDBTypeId.ARRAY: {
      const item = renderValueProjection(child, type.valueType, depth + 1);
      // A fixed-size array becomes a list for the subquery to unnest.
      const items = holdsJson(type.valueType)
        ? walkedItems(type.typeId === DuckDBTypeId.ARRAY ? `list_transform(${expression}, ${child} -> ${child})` : expression, child, depth, item.sql)
        : `list_transform(${expression}, ${child} -> ${item.sql})`;
      return { kind: "list", sql: nullable(`struct_pack(items := ${items})`), item };
    }
    case DuckDBTypeId.STRUCT: {
      // An unnamed tuple serializes every field under the empty name; the
      // parser keeps the last. Named fields are unique.
      const indices = type.entryNames.map((_, i) => i).filter(i => type.entryNames.lastIndexOf(type.entryNames[i]) === i);
      const fields = indices.map(i => renderValueProjection(type.entryNames[i]
        ? `${expression}.${quoteIdent(type.entryNames[i])}` : `struct_extract(${expression}, ${i + 1})`, type.entryTypes[i], depth + 1));
      return { kind: "struct", sql: nullable(`struct_pack(${fields.map((f, i) => `v${i} := ${f.sql}`).join(", ")})`), names: indices.map(i => type.entryNames[i]), fields };
    }
    case DuckDBTypeId.MAP: {
      // to_json names each member by its key's text, which the engine
      // quotes where a nested or binary key could otherwise read as another.
      const key = `CAST(${child}.key AS VARCHAR)`;
      const value = renderValueProjection(`${child}.value`, type.valueType, depth + 1);
      const entry = `struct_pack(key_bytes := ${stringByteLength(key)}, key := ${key}, value := ${value.sql})`;
      const items = holdsJson(type.valueType)
        ? walkedItems(`map_entries(${expression})`, child, depth, entry)
        : `list_transform(map_entries(${expression}), ${child} -> ${entry})`;
      return { kind: "map", sql: nullable(`struct_pack(items := ${items})`), value };
    }
    case DuckDBTypeId.UNION: {
      const members = type.memberTypes.map((t, i) => renderValueProjection(`union_extract(${expression}, '${type.memberTags[i].replaceAll("'", "''")}')`, t, depth + 1));
      return {
        kind: "union",
        sql: nullable(`struct_pack(tag := CASE union_tag(${expression}) ${type.memberTags.map((tag, i) => `WHEN '${tag.replaceAll("'", "''")}' THEN ${i}`).join(" ")} END, ${members.map((m, i) => `v${i} := ${m.sql}`).join(", ")})`),
        tags: type.memberTags,
        members,
      };
    }
    case DuckDBTypeId.BOOLEAN:
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.UHUGEINT:
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
      return { kind: "number", sql: expression };
    case DuckDBTypeId.VARCHAR:
      return { kind: "text", sql: nullable(`struct_pack(bytes := ${stringByteLength(expression)}, value := ${expression})`) };
    case DuckDBTypeId.ENUM:
      return { kind: "text", sql: nullable(`struct_pack(bytes := ${stringByteLength(`CAST(${expression} AS VARCHAR)`)}, value := CAST(${expression} AS VARCHAR))`) };
    default:
      return { kind: "json", sql: nullable(jsonText(expression)) };
  }
}

/** Reads one admitted value, charging its exact serialized bytes as it goes. */
export function decodeRenderValue(vector: DuckDBVector, index: number, value: RenderValue, budget: ByteBudget): unknown {
  if (value.kind === "number") {
    const item = vector.getItem(index) as number | bigint | boolean | null;
    // A wide integer becomes the nearest double, as parsing its digits does;
    // a value with no JSON spelling fails as parsing the engine's text did.
    const parsed = typeof item === "bigint" ? Number(item) : item;
    if (typeof parsed === "number" && !Number.isFinite(parsed)) JSON.parse(String(parsed));
    budget.take(jsonBytes(parsed));
    return parsed;
  }
  const cell = vector as DuckDBStructVector;
  if (!cell.isItemValid(index)) { budget.take(4); return null; }
  switch (value.kind) {
    case "text":
      budget.take(Number(cell.entryVectorAt(0).getItem(index)));
      return cell.entryVectorAt(1).getItem(index);
    case "json": {
      const bytes = cell.entryVectorAt(0).getItem(index);
      if (bytes !== null) budget.take(Number(bytes));
      const parsed: unknown = JSON.parse(cell.entryVectorAt(1).getItem(index) as string);
      if (bytes === null) budget.take(jsonBytes(parsed));
      return parsed;
    }
    case "list": {
      const list = cell.entryVectorAt(0) as DuckDBListVector;
      const count = list.getEntryLength(index);
      budget.take(2 + Math.max(0, count - 1));
      const offset = list.getEntryOffset(index);
      const result: unknown[] = [];
      for (let i = 0; i < count; i++) result.push(decodeRenderValue(list.childVector, offset + i, value.item, budget));
      return result;
    }
    case "struct": {
      budget.take(2 + Math.max(0, value.names.length - 1));
      const result: Record<string, unknown> = {};
      for (let i = 0; i < value.names.length; i++) {
        budget.take(jsonBytes(value.names[i]) + 1);
        setOwn(result, value.names[i], decodeRenderValue(cell.entryVectorAt(i), index, value.fields[i], budget));
      }
      return result;
    }
    case "union": {
      const member = Number(cell.entryVectorAt(0).getItem(index));
      const tag = value.tags[member];
      budget.take(2 + jsonBytes(tag) + 1);
      const result: Record<string, unknown> = {};
      setOwn(result, tag, decodeRenderValue(cell.entryVectorAt(member + 1), index, value.members[member], budget));
      return result;
    }
    case "map": {
      const list = cell.entryVectorAt(0) as DuckDBListVector;
      const entries = list.childVector as DuckDBStructVector;
      const count = list.getEntryLength(index);
      const offset = list.getEntryOffset(index);
      budget.take(2 + Math.max(0, count - 1));
      const result: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        budget.take(Number(entries.entryVectorAt(0).getItem(offset + i)) + 1);
        setOwn(result, entries.entryVectorAt(1).getItem(offset + i) as string, decodeRenderValue(entries.entryVectorAt(2), offset + i, value.value, budget));
      }
      return result;
    }
    case "tree":
      return decodeTree(cell, index, budget);
  }
}

function decodeTree(tree: DuckDBStructVector, index: number, budget: ByteBudget): unknown {
  const repeated = tree.entryVectorAt(0).getItem(index) === true;
  const list = tree.entryVectorAt(1) as DuckDBListVector;
  const nodes = list.childVector as DuckDBStructVector;
  const [types, ids, parents, keyBytes, keys, bytes, atoms] = Array.from({ length: 7 }, (_, i) => nodes.entryVectorAt(i));
  const end = list.getEntryOffset(index) + list.getEntryLength(index);
  let cursor = list.getEntryOffset(index);
  // Document order numbers a node's descendants after it and before
  // anything that follows it, so its subtree is the run of nodes whose
  // parent is it or a later node.
  const within = (row: number, container: number) => row < end && (parents.getItem(row) as number) >= container;
  const skip = (): void => {
    const own = ids.getItem(cursor++) as number;
    while (within(cursor, own)) cursor++;
  };
  // Whether each member of the object is the first and the last of its name.
  const occurrences = (container: number): { first: boolean; last: boolean }[] => {
    const names: string[] = [];
    for (let row = cursor; within(row, container); row++) {
      if (parents.getItem(row) === container) names.push(keys.getItem(row) as string);
    }
    const firstAt = new Map<string, number>(), lastAt = new Map<string, number>();
    names.forEach((name, i) => { if (!firstAt.has(name)) firstAt.set(name, i); lastAt.set(name, i); });
    return names.map((name, i) => ({ first: firstAt.get(name) === i, last: lastAt.get(name) === i }));
  };
  const next = (): unknown => {
    const row = cursor++;
    const type = types.getItem(row) as string;
    if (type === "OBJECT") {
      const own = ids.getItem(row) as number;
      budget.take(2);
      const marks = repeated ? occurrences(own) : null;
      const result: Record<string, unknown> = {};
      let shown = 0;
      for (let i = 0; within(cursor, own); i++) {
        const member = cursor;
        const { first, last } = marks ? marks[i] : { first: true, last: true };
        if (first) budget.take((shown++ ? 1 : 0) + Number(keyBytes.getItem(member)) + 1);
        const key = keys.getItem(member) as string;
        // The first of repeated names holds the member's place; the last
        // supplies its value; those between are skipped unread.
        if (!last) { setOwn(result, key, undefined); skip(); continue; }
        setOwn(result, key, next());
      }
      return result;
    }
    if (type === "ARRAY") {
      const own = ids.getItem(row) as number;
      budget.take(2);
      const result: unknown[] = [];
      while (within(cursor, own)) {
        if (result.length) budget.take(1);
        result.push(next());
      }
      return result;
    }
    const known = bytes.getItem(row);
    if (known !== null) budget.take(Number(known));
    if (type === "NULL") return null;
    const parsed: unknown = JSON.parse(atoms.getItem(row) as string);
    if (known === null) budget.take(jsonBytes(parsed));
    return parsed;
  };
  return next();
}
