import { accountChoices } from "@/lib/settings/account";
import { settingDefinition } from "@/lib/settings/catalogue";
import { validateStoredValue } from "@/lib/settings/validation";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { instanceName, setInstanceName, type ScreenPrefs, type ViewPrefs } from "@/lib/metadata/settings";
import { accountLook, accountSourceGrouping, accountViewPrefs, mergeAccountLook, mergeAccountViewPrefs, setAccountSourceGrouping,
  type SourceGrouping } from "@/lib/metadata/account-preferences";
import { LOOK_KEYS, type LookKey } from "@/lib/look";
import { requireCurrentActor, type AuthContext } from "./credentials";
import { AuthError } from "./errors";

const NAME_MAX = 80;

/** Accept only the documented shape: per-screen view/sort. */
function normalizeViewPrefs(input: unknown): ViewPrefs {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AuthError(
      "invalid_request",
      'viewPrefs must be an object like { maps: { view, sort }, data: …, workflows: …, projects: … }.',
      400,
    );
  }
  const out: ViewPrefs = {};
  for (const screen of ["maps", "data", "workflows", "projects"] as const) {
    const slice = (input as Record<string, unknown>)[screen];
    if (slice === undefined) continue;
    if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
      throw new AuthError(
        "invalid_request",
        `viewPrefs.${screen} must be an object.`,
        400,
      );
    }
    const { view, sort } = slice as Record<string, unknown>;
    const normalized: ScreenPrefs = {};
    if (view !== undefined) {
      const choices = accountChoices(`${screen}.view`);
      if (typeof view !== "string" || !choices.includes(view)) {
        throw new AuthError(
          "invalid_request",
          `viewPrefs.${screen}.view must be ${choices.map(value => JSON.stringify(value)).join(" or ")}.`,
          400,
        );
      }
      normalized.view = view as ScreenPrefs["view"];
    }
    if (sort !== undefined) {
      const choices = accountChoices(`${screen}.sort`);
      if (
        typeof sort !== "string" ||
        !choices.includes(sort)
      ) {
        throw new AuthError(
          "invalid_request",
          `viewPrefs.${screen}.sort must be one of ${choices.join(", ")}.`,
          400,
        );
      }
      normalized.sort = sort;
    }
    out[screen] = normalized;
  }
  return out;
}

/** The look's slice, checked whole against the catalogue: a value outside its
 * pick's choices, or a key the slice does not have, refuses the body. A bad
 * value is named as `look.<key>: reason`; an unknown key is named by its
 * position in the slice and never repeated, because a posted key may hold a
 * credential and refusals are logged. Unlike the rest of the body, the slice
 * tolerates nothing unknown: a misspelt pick would otherwise be accepted and
 * silently change nothing. */
function normalizeLookPatch(input: unknown): Partial<Record<LookKey, string>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AuthError("invalid_request", "look: Expected an object of look settings.", 400);
  }
  const out: Partial<Record<LookKey, string>> = {}, problems: string[] = [];
  for (const [index, [key, value]] of Object.entries(input).entries()) {
    if (!(LOOK_KEYS as readonly string[]).includes(key)) {
      problems.push(`look: Unknown setting at position ${index + 1}. Expected one of: ${LOOK_KEYS.join(", ")}.`);
      continue;
    }
    const result = validateStoredValue(settingDefinition(`look.${key}`), value);
    if (result.ok) out[key as LookKey] = result.value as string;
    else problems.push(`look.${key}: ${result.reason}`);
  }
  if (problems.length) throw new AuthError("invalid_request", problems.join(" "), 400);
  return out;
}

interface SettingsPatch {
  displayName?: string; instanceName?: string | null; viewPrefs?: ViewPrefs; sourceGrouping?: SourceGrouping;
  look?: Partial<Record<LookKey, string>>;
}

function normalizePatch(input: unknown): SettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthError("invalid_request", "Expected a JSON body.", 400);
  }
  const body = input as Record<string, unknown>, patch: SettingsPatch = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.trim().length > NAME_MAX) {
      throw new AuthError("invalid_request", `"displayName" must be a non-empty string of at most ${NAME_MAX} characters.`, 400);
    }
    patch.displayName = body.displayName.trim();
  }
  if (body.instanceName !== undefined) {
    if (body.instanceName !== null && typeof body.instanceName !== "string") {
      throw new AuthError("invalid_request", '"instanceName" must be a string, or null to clear it.', 400);
    }
    const trimmed = typeof body.instanceName === "string" ? body.instanceName.trim() : "";
    if (trimmed.length > NAME_MAX) throw new AuthError("invalid_request", `"instanceName" must be at most ${NAME_MAX} characters.`, 400);
    patch.instanceName = trimmed || null;
  }
  if (body.viewPrefs !== undefined) patch.viewPrefs = normalizeViewPrefs(body.viewPrefs);
  if (body.sourceGrouping !== undefined) {
    const choices = accountChoices("sourceGrouping");
    if (typeof body.sourceGrouping !== "string" || !choices.includes(body.sourceGrouping)) {
      throw new AuthError("invalid_request", `"sourceGrouping" must be ${choices.map(value => JSON.stringify(value)).join(" or ")}.`, 400);
    }
    patch.sourceGrouping = body.sourceGrouping as SourceGrouping;
  }
  if (body.look !== undefined) patch.look = normalizeLookPatch(body.look);
  return patch;
}

export function readOwnSettings(context: AuthContext, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => {
    const account = requireCurrentActor(context, db, now);
    return { displayName: account.name, instanceName: instanceName(db), viewPrefs: accountViewPrefs(account.id, db),
      sourceGrouping: accountSourceGrouping(account.id, db), look: accountLook(account.id, db) };
  }).immediate();
}

/** Personal fields always address the current credential's account. */
export function patchOwnSettings(context: AuthContext, input: unknown, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => {
    const account = requireCurrentActor(context, db, now);
    const patch = normalizePatch(input);
    if (patch.instanceName !== undefined && !account.isAdmin) {
      throw new AuthError("forbidden", "An admin account is required.", 403);
    }
    if (patch.displayName !== undefined) {
      db.prepare("UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?")
        .run(patch.displayName, new Date(now).toISOString(), account.id);
    }
    if (patch.instanceName !== undefined) setInstanceName(patch.instanceName, db);
    if (patch.viewPrefs !== undefined) mergeAccountViewPrefs(account.id, patch.viewPrefs, db);
    if (patch.sourceGrouping !== undefined) setAccountSourceGrouping(account.id, patch.sourceGrouping, db);
    if (patch.look !== undefined) mergeAccountLook(account.id, patch.look, db);
    return readOwnSettings(context, db, now);
  }).immediate();
}
