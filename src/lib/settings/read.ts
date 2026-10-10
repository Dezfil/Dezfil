import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { EXPORT_MAX_DIMENSION } from "@/lib/export/space";
import { maxBatchRows, maxIsochroneOrigins } from "@/lib/operations/provider-capacities";
import { SETTING_CATALOGUE } from "./catalogue";
import { disclosedDefinition } from "./disclosure";
import { readDeploymentSetting } from "./deployment-read";
import { serviceAddressSetting } from "./service-address";
import { lockedEnvironment, resolveNumericSettings } from "./resolver";
import { readStoredSettings } from "./store";
import type { NumericOverrides } from "./state";
import type { SettingDefinition, SettingValue } from "./types";
import { startedAt, version } from "./process-info";
import { settingsWarnings } from "./relationships";
import { readPartStates } from "@/lib/system/parts";

/** A row a variable sets. One an admin may also store beside it (the
 * satellite credit) reads as its variable while that is set, which locks
 * it and leaves the stored value behind it as storedValue; else as the
 * stored value, else the default. */
function besideItsVariable(definition: SettingDefinition, stored: Readonly<Record<string, SettingValue>>) {
  if (!definition.editable) return readDeploymentSetting(definition);
  const storedValue = stored[definition.key] ?? null;
  if (lockedEnvironment(definition)) return { ...readDeploymentSetting(definition), storedValue };
  return { value: storedValue ?? definition.defaultValue, source: storedValue === null ? "default" as const : "stored" as const,
    storedValue, locked: false, invalidOverride: false };
}

export function readInstanceSettings(context: AuthContext, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => {
    requireAdmin(context, db, now);
    const stored = readStoredSettings(db);
    const numbers = resolveNumericSettings({ stored: stored as NumericOverrides });
    const budget = { queryTimeoutMs: numbers.queryTimeoutS.value * 1000, operationTimeoutMs: numbers.operationTimeoutS.value * 1000,
      geocodePaceMs: numbers.geocodePaceMs.value, geocodeRequestTimeoutMs: numbers.geocodeRequestTimeoutS.value * 1000,
      isochronePaceMs: numbers.isochronePaceMs.value, isochroneRequestTimeoutMs: numbers.isochroneRequestTimeoutS.value * 1000 };
    const settings = Object.fromEntries(SETTING_CATALOGUE.filter(d => d.scope !== "account").map(definition => {
      const resolved = numbers[definition.key] ?? (definition.write?.kind === "address" ? serviceAddressSetting(definition, db)
        : definition.environment ? besideItsVariable(definition, stored) : {
        value: stored[definition.key] ?? definition.defaultValue,
        source: definition.key in stored ? "stored" : "default", storedValue: stored[definition.key] ?? null,
        locked: false, invalidOverride: false,
      });
      return [definition.key, { ...disclosedDefinition(definition), ...resolved }];
    }));
    return { settings, capacities: { geocodeRows: maxBatchRows(budget), isochroneOrigins: maxIsochroneOrigins(budget) },
      maxImageDimension: EXPORT_MAX_DIMENSION, version, startedAt, warnings: settingsWarnings(numbers.queryTimeoutS.value, numbers.operationTimeoutS.value),
      // Each part's state, read without starting anything.
      parts: readPartStates({ imagesAtOnce: numbers.exportRenderConcurrency.value, metadataFile: db.name }) };
  }).immediate();
}
