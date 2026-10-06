import { settingDefinition } from "./catalogue";

/** Account choices share their write constraint with the published schema. */
export function accountChoices(key: string): readonly string[] {
  const definition = settingDefinition(key);
  if (definition.scope !== "account" || definition.write?.kind !== "choice") {
    throw new Error(`Not an account choice: ${key}`);
  }
  return definition.write.values;
}

export function accountChoiceSchema(key: string) {
  return { type: "string", enum: accountChoices(key) };
}
