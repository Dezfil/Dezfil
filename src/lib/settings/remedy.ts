import { settingDefinition } from "./catalogue";
import type { NumericSettingKey } from "./numeric";
import { lockedEnvironment } from "./resolver";
import type { ServiceAddressKey } from "./types";

/** A remedy that remains true for API-only administration and deployment
 * locks: the setting while an admin may change it, the variable and a
 * restart while the variable locks it. */
export function settingRemedy(key: NumericSettingKey | ServiceAddressKey): string {
  const definition = settingDefinition(key);
  if (!definition.editable) throw new Error(`Not an editable setting: ${key}`);
  const variable = lockedEnvironment(definition);
  return variable
    ? `Change ${variable} and restart to change "${definition.label}".`
    : `An admin can change "${definition.label}".`;
}
