import type { SettingDefault, SettingDefinition } from "./types";

export type AddressDisclosure = { set: false } | { set: true; origin: string } | { set: true; unreadable: true };

/** A path or template can contain credentials just as user information or a query can. */
export function discloseAddress(value: string | null): AddressDisclosure {
  if (!value?.trim()) return { set: false };
  try {
    const url = new URL(value);
    if (!url.host) return { set: true, unreadable: true };
    return { set: true, origin: `${url.protocol}//${url.host}` };
  } catch { return { set: true, unreadable: true }; }
}

export function disclosedDefault(definition: SettingDefinition): SettingDefault | AddressDisclosure | { set: boolean } {
  if (definition.secret) return definition.key === "secretKey" ? { rule: "key-file-or-generate" } : { set: false };
  if (definition.kind === "address" && (typeof definition.defaultValue === "string" || definition.defaultValue === null)) {
    return discloseAddress(definition.defaultValue);
  }
  return definition.defaultValue;
}

/** Shared static metadata for the read and its schema. No environment enters this projection. */
export function disclosedDefinition(definition: SettingDefinition) {
  return { ...definition, defaultValue: disclosedDefault(definition) };
}
