import type { Database } from "better-sqlite3";
import { realpathSync } from "node:fs";
import { observeTransactionBoundary } from "@/lib/metadata/transaction-boundary";
import { SETTING_CATALOGUE, settingDefinition } from "./catalogue";
import { NUMERIC_SETTINGS } from "./numeric";
import { validateStoredValue } from "./validation";
import type { SettingDefinition, SettingValue } from "./types";
import { lockedEnvironment } from "./resolver";
import { activateCommittedSettings, publishCommittedSettings, releaseCommittedSettings, type NumericOverrides } from "./state";

const storeKey = Symbol.for("dezfil.settings-store");
type ObservedStore = Database & { [storeKey]?: { identity: string | Database; dirty: boolean } };

function storageKey(key: string): string { return key === "instanceName" ? "instance_name" : `instance.${key}`; }

/** Every value is stored as its text. A number reads back through Number,
 * which returns exactly the number written; a switch from "true" or
 * "false". Anything else then fails validation and reads as unset. */
function fromText(definition: SettingDefinition, raw: string): unknown {
  if (definition.kind === "number") return Number(raw);
  if (definition.kind === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

/** Instance text stays in SQLite, including the row used by the legacy writer. */
export function readStoredSettings(db: Database): Record<string, SettingValue> {
  const rows = db.prepare("SELECT key, value FROM workspace_settings").all() as { key: string; value: string }[];
  const stored = new Map(rows.map(row => [row.key, row.value]));
  const result: Record<string, SettingValue> = {};
  for (const definition of SETTING_CATALOGUE) {
    if (definition.scope !== "instance" || !definition.editable) continue;
    const raw = stored.get(storageKey(definition.key));
    if (raw === undefined) continue;
    const value = validateStoredValue(definition, fromText(definition, raw));
    if (value.ok && value.value !== null) result[definition.key] = value.value;
  }
  return result;
}

const NUMERIC_LIMITS = new Set<string>(NUMERIC_SETTINGS.map(definition => definition.key));

/** The committed snapshot holds the numeric limits alone. Any other stored
 * number (a default for new things) never enters it, so changing one never
 * wakes the limits' listeners. */
function numericOverrides(db: Database): NumericOverrides {
  return Object.fromEntries(Object.entries(readStoredSettings(db))
    .filter(([key, value]) => NUMERIC_LIMITS.has(key) && typeof value === "number")) as NumericOverrides;
}

/** Installed when a store opens, before callers can construct transactions. An
 * explicit open observes commits but never selects itself as the active store. */
export function observeSettingsStore(db: Database): void {
  const observed = db as ObservedStore;
  if (observed[storeKey]) return;
  const state = observed[storeKey] = { identity: db.memory ? db : realpathSync(db.name), dirty: false };
  observeTransactionBoundary(db, () => {
    if (!state.dirty) return;
    const values = numericOverrides(db);
    state.dirty = false;
    publishCommittedSettings(state.identity, values);
  }, () => releaseCommittedSettings(db));
}

/** Startup selects the application's store. Tests may explicitly select an
 * isolated memory store; closing its last owner removes the snapshot. */
export function activateSettingsStore(db: Database): void {
  if (db.inTransaction) throw new Error("Settings must be loaded outside a transaction.");
  observeSettingsStore(db);
  activateCommittedSettings((db as ObservedStore)[storeKey]!.identity, db, numericOverrides(db));
}

/** Repository write boundary. Authority and the resulting configuration's
 * relationships are checked by the operation inside its enclosing transaction. */
export function writeStoredSettings(patch: Readonly<Record<string, unknown>>, db: Database): void {
  observeSettingsStore(db);
  db.transaction(() => {
    const entries = Object.entries(patch).map(([key, input]) => {
      const definition = settingDefinition(key);
      if (!definition.editable || definition.scope !== "instance") throw new Error(`${key}: Setting is read-only.`);
      const lock = lockedEnvironment(definition);
      if (lock) throw new Error(`${key}: Locked by ${lock}.`);
      const validated = validateStoredValue(definition, input);
      if (!validated.ok) throw new Error(`${key}: ${validated.reason}`);
      return [key, validated.value] as const;
    });
    for (const [key, value] of entries) {
      if (value === null) db.prepare("DELETE FROM workspace_settings WHERE key = ?").run(storageKey(key));
      else db.prepare(`INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(storageKey(key), String(value), new Date().toISOString());
    }
    (db as ObservedStore)[storeKey]!.dirty = true;
  }).immediate();
}
