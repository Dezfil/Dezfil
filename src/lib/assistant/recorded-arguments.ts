import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { addressOrigin } from "@/lib/settings/disclosure";

/**
 * A call's arguments as the record keeps them.
 *
 * A service address given to the assistant may carry a key in its user
 * information, path or query. The call itself goes out with what was given;
 * everything the server forms about the call afterwards (its event, the
 * pending receipt, the settled confirmation, the confirmation's words and
 * the record's line) holds the address as scheme and host alone. Which
 * arguments are addresses is the settings catalogue's word: every key it
 * writes with the address kind. The conversation, what the person and the
 * model wrote, is theirs and is not touched here.
 */

const ADDRESS_KEYS: ReadonlySet<string> = new Set(
  SETTING_CATALOGUE.filter(definition => definition.write?.kind === "address").map(definition => definition.key),
);

/** What stands for text given as an address that is not one. */
const NOT_AN_ADDRESS = "not an address";

export function recordedArguments(args: Record<string, unknown>): Record<string, unknown> {
  let recorded: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (!ADDRESS_KEYS.has(key) || typeof value !== "string" || value.trim() === "") continue;
    recorded ??= { ...args };
    recorded[key] = addressOrigin(value) ?? NOT_AN_ADDRESS;
  }
  return recorded ?? args;
}
