import { DuckDBListVector, DuckDBStructVector, type DuckDBVector } from "@duckdb/node-api";
import { jsonBytes, type CellBudget } from "./result-budget";

/** Keep coordinates native until admitted. Parsing GeoJSON in the engine as
 * doubles matches JSON.parse's number conversion, including exponent spelling
 * and rounding. Only geometry objects are retained from the native JSON walk;
 * coordinate arrays stay typed vectors, not a JavaScript string or whole list. */
function coordinateProjection(expression: string): string {
  const node = (value: string) => {
    const kind = `json_extract_string(${value}, '$.type')`;
    const coords = `json_extract(${value}, '$.coordinates')`;
    return `struct_pack(
      kind := ${kind},
      children := CASE WHEN ${kind} = 'GeometryCollection' THEN json_array_length(${value}, '$.geometries') ELSE NULL END,
      coordinates := from_json(CASE ${kind}
        WHEN 'Point' THEN '[[[' || ${coords} || ']]]'
        WHEN 'LineString' THEN '[[' || ${coords} || ']]'
        WHEN 'MultiPoint' THEN '[[' || ${coords} || ']]'
        WHEN 'Polygon' THEN '[' || ${coords} || ']'
        WHEN 'MultiLineString' THEN '[' || ${coords} || ']'
        WHEN 'MultiPolygon' THEN CAST(${coords} AS VARCHAR)
        END, '\"DOUBLE[][][][]\"')
    )`;
  };
  const collection = `json_extract_string(${expression}, '$.type') = 'GeometryCollection'`;
  return `CASE WHEN ${expression} IS NULL THEN NULL
    WHEN NOT (${collection}) THEN [${node(expression)}]
    ELSE (SELECT list(${node("value")} ORDER BY id)
      FROM json_tree(CASE WHEN ${collection} THEN ${expression} ELSE NULL END) WHERE type = 'OBJECT') END`;

}

export function geojsonProjection(expression: string): string {
  // The native writer emits integral doubles with a .0 suffix. Removing that
  // suffix is exact for JSON.parse followed by JSON.stringify.
  expression = String.raw`regexp_replace(${expression}, '\.0([,\]])', '\1', 'g')`;
  // Integer-coordinate GeoJSON is already in JSON.stringify's number form.
  // Keep that common case as text, with its length checked before decoding.
  // Decimal/exponent/large-number cases use native coordinates so rounding and
  // notation can change the byte count without first decoding an oversized cell.
  const integerJSON = `NOT regexp_matches(${expression}, '[0-9][.eE]|[0-9]{16}|-0[,\\]]')`;
  const text = `CASE WHEN ${integerJSON} THEN ${expression} END`;
  return `struct_pack(bytes := octet_length(encode(${text})), text := ${text},
    objects := ${coordinateProjection(`CASE WHEN NOT (${integerJSON}) THEN ${expression} END`)})`;
}

function coordinates(vector: DuckDBVector, index: number, depth: number, budget: CellBudget): unknown {
  if (depth === 0) {
    const number = vector.getItem(index) as number | null;
    budget.take(jsonBytes(number));
    return number;
  }
  const items = (vector as DuckDBListVector).getItemVector(index);
  if (!items) { budget.take(4); return null; }
  budget.take(2 + Math.max(0, items.itemCount - 1));
  const values: unknown[] = [];
  for (let i = 0; i < items.itemCount; i++) values.push(coordinates(items, i, depth - 1, budget));
  return values;
}

export function decodeGeoJSON(vector: DuckDBVector, index: number, budget: CellBudget): unknown {
  const cell = vector as DuckDBStructVector;
  const bytes = cell.entryVectorAt(0).getItem(index);
  if (bytes !== null) {
    budget.take(Number(bytes));
    return JSON.parse(cell.entryVectorAt(1).getItem(index) as string);
  }
  const objects = (cell.entryVectorAt(2) as DuckDBListVector).getItemVector(index) as DuckDBStructVector | null;
  if (!objects) { budget.take(4); return null; }
  let cursor = 0;
  function next(): unknown {
    const row = cursor++;
    const type = objects!.entryVectorAt(0).getItem(row) as string;
    if (type === "GeometryCollection") {
      const count = Number(objects!.entryVectorAt(1).getItem(row));
      budget.take(jsonBytes({ type, geometries: [] }) + Math.max(0, count - 1));
      const geometries: unknown[] = [];
      for (let i = 0; i < count; i++) geometries.push(next());
      return { type, geometries };
    }
    const depth = type === "Point" ? 1 : type === "LineString" || type === "MultiPoint" ? 2 : type === "Polygon" || type === "MultiLineString" ? 3 : 4;
    budget.take(jsonBytes({ type, coordinates: null }) - 4);
    let values = objects!.entryVectorAt(2);
    let position = row;
    for (let wrap = depth; wrap < 4; wrap++) {
      values = (values as DuckDBListVector).getItemVector(position)!;
      position = 0;
    }
    return { type, coordinates: coordinates(values, position, depth, budget) };
  }
  return next();
}
