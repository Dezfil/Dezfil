import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { SETTING_CATALOGUE } from "./catalogue";
import { lockedEnvironment, resolveNumericSettings } from "./resolver";
import { validateStoredValue } from "./validation";
import { readStoredSettings, writeStoredSettings } from "./store";
import { readInstanceSettings } from "./read";
import { settingsWarnings } from "./relationships";
import type { SettingValue } from "./types";
import type { NumericOverrides } from "./state";

/** The write lock covers authority, validation, storage and response assembly.
 * The repository publishes consumers only when the enclosing commit succeeds. */
export function changeInstanceSettings(context: AuthContext, input: unknown, db: Database = metadataDb(), now = Date.now()) {
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
      const environment = lockedEnvironment(definition);
      if (environment) { locked = true; problems.push(`${key}: Locked by ${environment}.`); continue; }
      if (definition.scope !== "instance") { problems.push(`${key}: Not an instance setting.`); continue; }
      const result = validateStoredValue(definition, value);
      if (!result.ok) problems.push(`${key}: ${result.reason}`);
      else patch[key] = result.value;
    }
    const resulting = { ...readStoredSettings(db), ...patch };
    // An existing deployment mismatch is reported by the read; unrelated edits
    // cannot repair it and must remain possible.
    if ("queryTimeoutS" in patch || "operationTimeoutS" in patch) {
      const numbers = resolveNumericSettings({ stored: resulting as NumericOverrides });
      problems.push(...settingsWarnings(numbers.queryTimeoutS.value, numbers.operationTimeoutS.value));
    }
    if (problems.length) throw new ApiError(locked ? "setting_locked" : "invalid_request", problems.join(" "), locked ? 409 : 400);
    writeStoredSettings(patch, db);
    return readInstanceSettings(context, db, now);
  }).immediate();
}
