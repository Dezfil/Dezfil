import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { disclosedDefinition } from "@/lib/settings/disclosure";
import type { StorageRead } from "@/lib/system/storage-answer";
import type { InstanceRead } from "./instance-read";
import type { ReadSetting } from "./server-set";

const EMPTY_CACHE = (budgetMb: number) => ({ bytes: 0, answers: 0, budgetMb });

/**
 * For tests: a configuration read shaped as the server answers it, every
 * definition it carries (none of an account's) in the catalogue's order,
 * each at its disclosed default unless `resolved` says how it resolved.
 */
export type Resolution = Partial<Pick<ReadSetting, "value" | "source" | "locked" | "invalidOverride" | "storedValue">>;

export function instanceReadFixture(resolved: Readonly<Record<string, Resolution>> = {},
  facts: Partial<Omit<InstanceRead, "settings">> = {}): InstanceRead {
  const settings = Object.fromEntries(SETTING_CATALOGUE.filter(definition => definition.scope !== "account").map(definition => {
    const disclosed = disclosedDefinition(definition);
    const setting = { ...disclosed, value: disclosed.defaultValue, source: "default", locked: false, invalidOverride: false, storedValue: null, ...resolved[definition.key] };
    return [definition.key, setting as ReadSetting];
  }));
  return {
    settings, capacities: { geocodeRows: 27, isochroneOrigins: 13 }, maxImageDimension: 4096,
    version: "0.1.0", startedAt: "2026-10-04T09:00:00.000Z", warnings: [],
    // As a fresh server reports them: the engine not started, both programs found, the tile builder not yet run.
    parts: {
      query_engine: { version: "1.5.4", started: false, extensions: [] },
      tile_builder: { found: true, version: null },
      image_renderer: { found: true, available: true, imagesAtOnce: 2 },
      metadata_database: { file: "metadata.sqlite" },
    },
    // As a fresh data folder reports them: every cache empty, no release list taken yet.
    services: { geocode: EMPTY_CACHE(64), isochrone: EMPTY_CACHE(64), overpass: EMPTY_CACHE(2048), overture: { listed: false } },
    ...facts,
  };
}

/** The read after stored values: each a stored source, or the default for a null. */
export function storedRead(stored: Readonly<Record<string, unknown>>, facts: Partial<Omit<InstanceRead, "settings">> = {}): InstanceRead {
  return instanceReadFixture(Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [key, { value, source: "stored", storedValue: value }])), facts);
}

const MIB = 1024 * 1024, GIB = 1024 * MIB;

/** For tests: a storage read shaped as the server answers it, every kind
 * counted to the end, unless `kinds` says otherwise; the total is what
 * the kinds add up to. */
export function storageReadFixture(kinds: Partial<StorageRead["kinds"]> = {}, disk: StorageRead["disk"] = { free: 182 * GIB, total: 250 * GIB }): StorageRead {
  const all: StorageRead["kinds"] = {
    tables: { bytes: 12_698 * MIB, files: 412, finished: true },
    tile_archives: { bytes: 3_174 * MIB, files: 83, finished: true },
    service_caches: { bytes: 6.5 * MIB, files: 120, finished: true },
    thumbnails: { bytes: 84 * MIB, files: 38, finished: true },
    templates: { bytes: 4 * MIB, files: 9, finished: true },
    metadata_database: { bytes: 46 * MIB, files: 3, finished: true },
    leftover_files: { bytes: 212 * MIB, files: 14, finished: true },
    other: { bytes: 40 * 1024, files: 2, finished: true },
    ...kinds,
  };
  const uses = Object.values(all);
  return { kinds: all, total: { bytes: uses.reduce((sum, use) => sum + use.bytes, 0), files: uses.reduce((sum, use) => sum + use.files, 0),
    finished: uses.every(use => use.finished) }, disk };
}
