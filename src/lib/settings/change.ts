import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { SETTING_CATALOGUE, settingDefinition } from "./catalogue";
import { lockedEnvironment, resolveNumericSettings } from "./resolver";
import { validateStoredValue } from "./validation";
import { readStoredSettings, writeStoredSettings } from "./store";
import { readInstanceSettings } from "./read";
import { settingsWarnings } from "./relationships";
import type { SettingValue } from "./types";
import type { NumericOverrides } from "./state";
import type { AddressAdmission } from "./address-admission";

/** What the resulting configuration holds for a key: the body's value, else
 * the stored one, else the default (a cleared value reads as its default). */
const resultingValue = (resulting: Readonly<Record<string, SettingValue>>, key: string) => resulting[key] ?? settingDefinition(key).defaultValue;

/** The rows that hold only together. No variable sets either side, so only a
 * change can break one: each is checked when a body touches either side,
 * against the configuration the body would leave, and refuses it whole. */
function rowProblems(patch: Readonly<Record<string, SettingValue>>, resulting: Readonly<Record<string, SettingValue>>): string[] {
  const problems: string[] = [];
  const touched = (...keys: string[]) => keys.some(key => key in patch);
  if (touched("security.failedPerAccount", "security.failedPerAddress")
    && (resultingValue(resulting, "security.failedPerAddress") as number) < (resultingValue(resulting, "security.failedPerAccount") as number)) {
    problems.push("security.failedPerAddress must be at least security.failedPerAccount.");
  }
  if (touched("publishing.embedding", "publishing.embedSites") && resultingValue(resulting, "publishing.embedding") === "listed"
    && !(resultingValue(resulting, "publishing.embedSites") as readonly string[]).length) {
    problems.push("publishing.embedSites must list at least one site while publishing.embedding is listed.");
  }
  return problems;
}

/** The write lock covers authority, validation, storage and response assembly.
 * The repository publishes consumers only when the enclosing commit succeeds.
 * A service address in the body must have passed the save-time check
 * (`admitServiceAddresses`) first, with the same value: its refusals join
 * the body's others, and an address the check never saw is not written. */
export function changeInstanceSettings(context: AuthContext, input: unknown, db: Database = metadataDb(), now = Date.now(),
  admission?: AddressAdmission) {
  return db.transaction(() => {
    requireAdmin(context, db, now);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ApiError("invalid_request", "Expected an object of instance settings.", 400);
    }
    const patch: Record<string, SettingValue> = {}, problems: string[] = [];
    let locked = false;
    for (const [index, [key, value]] of Object.entries(input).entries()) {
      const definition = SETTING_CATALOGUE.find(candidate => candidate.key === key);
      if (!definition) {
        // Arbitrary key text, just like arbitrary values, may contain a credential.
        problems.push(`Unknown setting key at position ${index + 1}.`);
        continue;
      }
      if (!definition.editable || definition.scope !== "instance") { problems.push(`${key}: Setting is read-only.`); continue; }
      const environment = lockedEnvironment(definition);
      if (environment) { locked = true; problems.push(`${key}: Locked by ${environment}.`); continue; }
      const result = validateStoredValue(definition, value);
      if (!result.ok) problems.push(`${key}: ${result.reason}`);
      else patch[key] = result.value;
      if (result.ok && definition.write?.kind === "address" && result.value !== null && admission?.checked.get(key) !== result.value) {
        throw new Error(`${key}: an address is written only after the save-time check.`);
      }
    }
    problems.push(...admission?.refusals ?? []);
    const resulting = { ...readStoredSettings(db), ...patch };
    // An existing deployment mismatch is reported by the read; unrelated edits
    // cannot repair it and must remain possible.
    if ("queryTimeoutS" in patch || "operationTimeoutS" in patch) {
      const numbers = resolveNumericSettings({ stored: resulting as NumericOverrides });
      problems.push(...settingsWarnings(numbers.queryTimeoutS.value, numbers.operationTimeoutS.value));
    }
    problems.push(...rowProblems(patch, resulting));
    if (problems.length) throw new ApiError(locked ? "setting_locked" : "invalid_request", problems.join(" "), locked ? 409 : 400);
    writeStoredSettings(patch, db);
    return readInstanceSettings(context, db, now);
  }).immediate();
}
