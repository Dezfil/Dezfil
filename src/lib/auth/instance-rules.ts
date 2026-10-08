import type { Database } from "better-sqlite3";
import { getAccount } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { ruleRefusal, type WhoMayRule } from "@/lib/settings/instance-rules";
import { AuthError } from "./errors";
import { securitySettings } from "./security-settings";

/**
 * Refuse the acting account when the instance's rule excludes it. The service
 * that takes the action calls this inside the transaction that writes it, so
 * the API, the generated tools, the embedded assistant and the MCP server meet
 * one refusal, and a rule saved while the request was on its way is the one
 * that decides. The refusal names the rule's key beside the sentence the
 * person's screen shows; nothing it refuses is written. It is the auth
 * code's own refusal, like forbidden, so token creation can raise it where
 * the web layer is not loaded.
 */
export function requireRule(accountId: string, key: WhoMayRule, db: Database = metadataDb()): void {
  const sentence = ruleRefusal(key, securitySettings(db).rules[key], getAccount(accountId, db)?.isAdmin === true);
  if (sentence) throw new AuthError("rule_refused", sentence, 403, { rule: key });
}
