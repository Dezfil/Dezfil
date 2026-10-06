import { settingDefinition } from "./catalogue";
import type { NumericSettingKey } from "./numeric";
import { lockedEnvironment } from "./resolver";

/** A remedy that remains true for API-only administration and deployment locks. */
export function settingRemedy(key: NumericSettingKey): string {
  const definition = settingDefinition(key);
  if (!definition.editable) throw new Error(`Not an editable setting: ${key}`);
  const variable = lockedEnvironment(definition);
  return variable
    ? `Change ${variable} and restart to change "${definition.label}".`
    : `An admin can change "${definition.label}".`;
}
