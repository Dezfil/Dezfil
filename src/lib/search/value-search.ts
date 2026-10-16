import { QueryResultTooLarge } from "@/lib/api/errors";
import type { DatasetScope } from "@/lib/query/access";
import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import { namedSql } from "@/lib/query/named-sql";
import { wrappable } from "@/lib/query/compile";
import { cappedText, cappedValue } from "@/lib/query/value-ceiling";
import { foldCase } from "./match";
import { VALUE_ROW_BOUND, type RefusedLayer, type ValueRow } from "./contract";

/**
 * Attribute-value search over the map's visible layers: each layer's
 * effective (filtered) result, genuine textual columns only,
 * case-insensitive substring with the query carried as bound data —
 * pattern characters stay literal — one row per matching feature, at
 * most 20 across layers.
 *
 * Two explicit hardening layers, per the boundary's contract: the
 * read-only SQL guard on every layer's effective query, then the
 * hardened bounded engine for the scan. One evaluation covers the whole
 * search — serial per-layer work under a single wall-clock budget, the
 * row budget stopping further layers once filled. A failing layer
 * contributes nothing and does not fail the search; the boundary's own
 * outcomes (interruption, the memory budget) propagate. A layer with a
 * match longer than the per-value ceiling answers no rows either, and is
 * named with that refusal, so a missing match never reads as no match.
 */

export interface ValueSearchLayer {
  layerId: string;
  layerName: string;
  /** The layer's effective SQL — filters applied, the reader's truth. */
  sql: string;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface ScanRow {
  __field: string;
  __value: string | null;
  __value_bytes: number | bigint;
  __ispoint: boolean;
  __anchor: string;
  __minx: number;
  __miny: number;
  __maxx: number;
  __maxy: number;
}

export async function searchValues(
  scope: DatasetScope,
  layers: ValueSearchLayer[],
  query: string,
  options: { signal?: AbortSignal; bound?: number } = {},
): Promise<{ values: ValueRow[]; refusedLayers: RefusedLayer[] }> {
  const bound = options.bound ?? VALUE_ROW_BOUND;
  if (query.trim() === "" || layers.length === 0 || bound <= 0) return { values: [], refusedLayers: [] };

  return boundedEvaluation(async (conn, bounds) => {
    const rows: ValueRow[] = [];
    const refusedLayers: RefusedLayer[] = [];
    for (const layer of layers) {
      if (rows.length >= bound) break;
      try {
        const compiledSql = await namedSql(conn, layer.sql);
        const sub = `(${wrappable(compiledSql)}) AS q`;

        const described = await conn.runAndReadAll(
          `DESCRIBE SELECT * FROM ${sub}`,
        );
        const columns = (
          described.getRowObjects() as unknown as {
            column_name: string;
            column_type: string;
          }[]
        ).map((c) => ({ name: c.column_name, type: c.column_type }));
        // Genuine text only: the field-kind abstraction calls every
        // non-numeric, non-time type "text" (booleans, lists, structs);
        // search must not.
        const textColumns = columns.filter((c) => c.type === "VARCHAR");
        const geometry = columns.find((c) => c.type.startsWith("GEOMETRY"));
        if (textColumns.length === 0 || !geometry) continue;

        // One scan, the first matching field per feature — one row per
        // feature. The needle joins once as bound data, pre-folded by
        // the shared matcher (ß → ss included); the column side folds
        // in-engine with lower() plus the ß replacement lower() alone
        // misses. `contains` is literal substring, so `%` and `_` stay
        // ordinary characters. Honest residual: a Turkish İ *in the
        // data* folds engine-side to i + combining dot and will not
        // match a plain-i query — full in-engine case folding needs
        // ICU, which the hardened instance does not load.
        const g = ident(geometry.name);
        const fold = (expr: string) => `replace(lower(${expr}), 'ß', 'ss')`;
        const firstMatch = (result: (c: string) => string) =>
          `CASE ${textColumns
            .map(
              (c) =>
                `WHEN contains(${fold(ident(c.name))}, __p.__n) THEN ${result(
                  c.name,
                )}`,
            )
            .join(" ")} END`;
        const scanned = await conn.runAndReadAll(
          `SELECT __field, ${cappedText("__match", "__value")}, __ispoint, __anchor, __minx, __miny, __maxx, __maxy FROM (
             SELECT ${firstMatch((c) => `'${c.replace(/'/g, "''")}'`)} AS __field,
                    ${firstMatch((c) => ident(c))} AS __match,
                    ST_GeometryType(${g}) = 'POINT' AS __ispoint,
                    ST_AsGeoJSON(ST_PointOnSurface(${g})) AS __anchor,
                    ST_XMin(${g}) AS __minx, ST_YMin(${g}) AS __miny,
                    ST_XMax(${g}) AS __maxx, ST_YMax(${g}) AS __maxy
             FROM ${sub}, (SELECT ${fold("?::VARCHAR")} AS __n) AS __p
             WHERE ${g} IS NOT NULL
           ) AS __s WHERE __field IS NOT NULL
           LIMIT ${bound - rows.length}`,
          [foldCase(query)],
        );
        // A layer answers whole or not at all: every match is read, and
        // held to the ceiling, before any is added.
        const found = (scanned.getRowObjects() as unknown as ScanRow[]).map((r): ValueRow => {
          const value = cappedValue(r as unknown as Record<string, unknown>, "__value");
          const anchor = (
            JSON.parse(String(r.__anchor)) as {
              coordinates: [number, number];
            }
          ).coordinates;
          return {
            layerId: layer.layerId,
            layerName: layer.layerName,
            field: String(r.__field),
            value,
            ...(r.__ispoint
              ? { point: anchor }
              : {
                  anchor,
                  bounds: [
                    Number(r.__minx),
                    Number(r.__miny),
                    Number(r.__maxx),
                    Number(r.__maxy),
                  ] as [number, number, number, number],
                }),
          };
        });
        rows.push(...found);
      } catch (error) {
        // The boundary's outcomes are never a layer's failure to skip.
        if (bounds.interrupted() || isOutOfMemory(error)) throw error;
        if (error instanceof QueryResultTooLarge) {
          refusedLayers.push({ layerId: layer.layerId, layerName: layer.layerName, error: error.message, errorCode: error.code });
        }
        continue;
      }
    }
    return { values: rows, refusedLayers };
  }, { scope, signal: options.signal });
}
