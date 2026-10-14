import { withTrustedOperation } from "@/lib/trusted-operation";
import { sharedTrustedWork } from "@/lib/trusted-shared";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import type { Bbox } from "@/lib/bbox";
import { overtureReadExpr } from "./query";
import { ensureOvertureSupport, mapOvertureError } from "./remote";

/**
 * Divisions metadata: the per-country division index that powers the level
 * picker (counts + samples), the city-by-name search, and scope resolution.
 * One remote read per (release, country), then everything is answered from
 * memory — a release is immutable, so entries never go stale. Geometry is
 * deliberately not indexed; scope polygons are fetched on demand and cached
 * separately.
 */

/** Overture division subtypes, coarse → fine. Unknown future subtypes are
 * carried through with a fallback label rather than dropped. */
export const DIVISION_SUBTYPE_ORDER = [
  "country",
  "dependency",
  "region",
  "county",
  "localadmin",
  "locality",
  "macrohood",
  "neighborhood",
  "microhood",
] as const;

export type DivisionSubtype = (typeof DIVISION_SUBTYPE_ORDER)[number];

/** Friendly labels — the raw subtype vocabulary is never the UI (spec). */
const SUBTYPE_LABELS: Record<DivisionSubtype, string> = {
  country: "Countries",
  dependency: "Dependencies",
  region: "States & regions",
  county: "Counties & districts",
  localadmin: "Municipalities",
  locality: "Cities & towns",
  macrohood: "City districts",
  neighborhood: "Neighborhoods",
  microhood: "Sub-neighborhoods",
};

export function subtypeLabel(subtype: string): string {
  return (
    SUBTYPE_LABELS[subtype as DivisionSubtype] ??
    subtype.charAt(0).toUpperCase() + subtype.slice(1)
  );
}

export function subtypeOrder(subtype: string): number {
  const i = (DIVISION_SUBTYPE_ORDER as readonly string[]).indexOf(subtype);
  return i === -1 ? DIVISION_SUBTYPE_ORDER.length : i;
}

/** Subtypes a typed city/municipality scope may resolve to — kreisfreie
 * Städte land as county, French communes as localadmin, German Gemeinden
 * as locality (verified live). */
export const CITY_SCOPE_SUBTYPES: DivisionSubtype[] = [
  "county",
  "localadmin",
  "locality",
];

/** What the city search offers: city-states — Berlin, Hamburg,
 * Bremen — are state-typed in the data, so region rows are searchable too,
 * kind-labelled for disambiguation. */
export const CITY_SEARCH_SUBTYPES: DivisionSubtype[] = [
  "region",
  ...CITY_SCOPE_SUBTYPES,
];

export interface DivisionIndexRow {
  divisionId: string;
  name: string;
  subtype: string;
  /** ISO 3166-2 code of the containing state, e.g. DE-HE. */
  region: string | null;
  bbox: Bbox;
}

export interface DivisionLevel {
  subtype: string;
  label: string;
  count: number;
  samples: string[];
}

export interface CountryEntry {
  code: string;
  name: string;
  /** The country's extent — the fit-to-selection target. */
  bbox: Bbox;
}

export interface DivisionMatch extends DivisionIndexRow {
  label: string;
}

/** Aggregate an index into the level list, coarse → fine (pure). */
export function aggregateLevels(rows: DivisionIndexRow[]): DivisionLevel[] {
  const bySubtype = new Map<string, { count: number; samples: string[] }>();
  for (const row of rows) {
    const entry = bySubtype.get(row.subtype) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 3 && row.name) entry.samples.push(row.name);
    bySubtype.set(row.subtype, entry);
  }
  return [...bySubtype.entries()]
    .map(([subtype, { count, samples }]) => ({
      subtype,
      label: subtypeLabel(subtype),
      count,
      samples,
    }))
    .sort((a, b) => subtypeOrder(a.subtype) - subtypeOrder(b.subtype));
}

/** Rank name matches: prefix first, then substring; ties by name length so
 * "Frankfurt am Main" beats "Frankfurt (Oder)-Umland" on "Frankfurt" (pure). */
export function searchIndex(
  rows: DivisionIndexRow[],
  query: string,
  subtypes: readonly string[] = CITY_SEARCH_SUBTYPES,
  limit = 10,
): DivisionMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const wanted = new Set(subtypes);
  const scored: { row: DivisionIndexRow; score: number }[] = [];
  for (const row of rows) {
    if (!wanted.has(row.subtype)) continue;
    const name = row.name.toLowerCase();
    const at = name.indexOf(q);
    if (at === -1) continue;
    scored.push({ row, score: (at === 0 ? 0 : 1000) + row.name.length });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ row }) => ({ ...row, label: subtypeLabel(row.subtype) }));
}

/** Land rows only; maritime duplicates are noise for boundary work (spec). */
const LAND = `coalesce(class, 'land') = 'land'`;

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function runDivisionsQuery(
  sql: string,
): Promise<Record<string, unknown>[]> {
  return withConnection(async (conn) => {
    await ensureOvertureSupport(conn);
    try {
      const result = await conn.runAndReadAll(sql);
      return result.getRowObjects() as Record<string, unknown>[];
    } catch (error) {
      mapOvertureError(error);
    }
  });
}

/** In-flight-deduplicating cache with LRU eviction. Promises are cached so
 * concurrent requests share one remote read; failures are evicted. */
class PromiseCache<V> {
  private map = new Map<string, ReturnType<typeof sharedTrustedWork<V>>>();
  constructor(private max: number) {}
  get(key: string, produce: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    if (hit) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, hit);
      return hit.join();
    }
    const entry = sharedTrustedWork({ kind: "interactive-read", name: "Overture divisions" }, produce);
    void entry.value.catch(() => {
      if (this.map.get(key) === entry) this.map.delete(key);
    });
    this.map.set(key, entry);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return entry.join();
  }
  clear(): void {
    this.map.clear();
  }
}

const countryCache = new PromiseCache<CountryEntry[]>(4);
const indexCache = new PromiseCache<DivisionIndexRow[]>(4);
const geometryCache = new PromiseCache<{ wkt: string; bbox: Bbox }>(8);

/** Tests reset the caches. */
export function resetDivisionCaches(): void {
  countryCache.clear();
  indexCache.clear();
  geometryCache.clear();
}

/** Countries present in a release, by ISO code, English-labelled when the
 * data carries a translation. */
export function listDivisionCountries(release: string, signal?: AbortSignal): Promise<CountryEntry[]> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture divisions", signal }, async () => {
    return countryCache.get(release, async () => {
      const rows = await runDivisionsQuery(
        `SELECT country AS code,
                any_value(coalesce(
                  list_extract(map_extract(names.common, 'en'), 1),
                  names."primary")) AS name,
                min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin,
                max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax
         FROM ${overtureReadExpr("divisions", release)}
         WHERE subtype = 'country' AND ${LAND} AND country IS NOT NULL
         GROUP BY country`,
      );
      return rows
        .map((r) => ({
          code: String(r.code),
          name: String(r.name),
          bbox: [
            Number(r.xmin),
            Number(r.ymin),
            Number(r.xmax),
            Number(r.ymax),
          ] as Bbox,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
    });
  });
}

/** The full division index of one country — the one remote read everything
 * else is answered from. */
export function countryDivisionIndex(
  release: string,
  country: string,
  signal?: AbortSignal,
): Promise<DivisionIndexRow[]> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture divisions", signal }, async () => {
    const code = country.toUpperCase();
    return indexCache.get(`${release}/${code}`, async () => {
      const rows = await runDivisionsQuery(
        `SELECT division_id AS id, names."primary" AS name, subtype, region,
                bbox.xmin AS xmin, bbox.ymin AS ymin,
                bbox.xmax AS xmax, bbox.ymax AS ymax
         FROM ${overtureReadExpr("divisions", release)}
         WHERE country = ${lit(code)} AND ${LAND}
           AND division_id IS NOT NULL AND names."primary" IS NOT NULL`,
      );
      return rows.map((r) => ({
        divisionId: String(r.id),
        name: String(r.name),
        subtype: String(r.subtype),
        region: r.region === null ? null : String(r.region),
        bbox: [
          Number(r.xmin),
          Number(r.ymin),
          Number(r.xmax),
          Number(r.ymax),
        ] as Bbox,
      }));
    });
  });
}

/** A scope polygon by division id, as WKT plus its bbox (for budget checks
 * and the containment prefilter). Fetched on demand — geometry never lives
 * in the index. */
export function divisionGeometry(
  release: string,
  divisionId: string,
  signal?: AbortSignal,
): Promise<{ wkt: string; bbox: Bbox }> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture divisions", signal }, async () => {
    return geometryCache.get(`${release}/${divisionId}`, async () => {
      const rows = await runDivisionsQuery(
        `SELECT ST_AsText(geometry) AS wkt,
                bbox.xmin AS xmin, bbox.ymin AS ymin,
                bbox.xmax AS xmax, bbox.ymax AS ymax
         FROM ${overtureReadExpr("divisions", release)}
         WHERE division_id = ${lit(divisionId)} AND ${LAND}
         LIMIT 1`,
      );
      if (rows.length === 0 || rows[0].wkt === null) {
        throw new ApiError(
          "invalid_request",
          "The selected scope no longer exists in this release. Pick it again.",
          404,
        );
      }
      const r = rows[0];
      return {
        wkt: String(r.wkt),
        bbox: [
          Number(r.xmin),
          Number(r.ymin),
          Number(r.xmax),
          Number(r.ymax),
        ] as Bbox,
      };
    });
  });
}
