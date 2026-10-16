import type { SettingDefault, SettingDefinition } from "./types";

export type AddressDisclosure = { set: false } | { set: true; origin: string; userInformation?: true } | { set: true; unreadable: true }
  | { set: true; folder: true };

/** Whether text is an http or https address, as the address kind takes one,
 * rather than a folder a variable may name instead. */
export function isWebAddress(text: string): boolean {
  return /^\s*https?:\/\//i.test(text);
}

/** Whether a setting's variable may name a folder on the server instead of
 * an address (the template catalogue's). */
export function variableMayNameFolder(definition: SettingDefinition): boolean {
  return definition.write?.kind === "address" && definition.write.folder === "variable";
}

/** A path or template can contain credentials just as user information or a query can.
 * Where asked (the imagery's tile template), it also says that the address
 * carries user information, never what it is: no imagery is drawn from it. */
export function discloseAddress(value: string | null, reportUserInformation = false): AddressDisclosure {
  if (!value?.trim()) return { set: false };
  try {
    const url = new URL(value);
    if (!url.host) return { set: true, unreadable: true };
    const carries = reportUserInformation && (url.username !== "" || url.password !== "");
    return { set: true, origin: `${url.protocol}//${url.host}`, ...(carries ? { userInformation: true as const } : {}) };
  } catch { return { set: true, unreadable: true }; }
}

/** Whether an address carries user information: a user name, a password or both. */
export function carriesUserInformation(address: string): boolean {
  try {
    const url = new URL(address);
    return url.username !== "" || url.password !== "";
  } catch { return false; }
}

/** Whether a setting's address takes no user information at save (the
 * imagery's tile template), so its read reports the one in effect carrying some. */
export function refusesUserInformation(definition: SettingDefinition): boolean {
  return definition.write?.kind === "address" && definition.write.userInformation === "refused";
}

/** What may be said about an address anywhere: its scheme and host (with a
 * port when it has one), or null for text that is not an address. Never
 * its user information, path, query or fragment. */
export function addressOrigin(address: string): string | null {
  const disclosed = discloseAddress(address);
  return "origin" in disclosed ? disclosed.origin : null;
}

/**
 * A record of the service a run or an import reached, as every read gives
 * it: its `endpoint` as scheme and host. Runs and imports now record the
 * origin alone; one recorded before that may hold the address's path, where
 * a key can travel, and is reduced here, at read time, while the stored row
 * stays as it was written.
 */
export function withRecordedOrigin(record: Record<string, unknown>): Record<string, unknown> {
  return typeof record.endpoint === "string" ? { ...record, endpoint: addressOrigin(record.endpoint) } : record;
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
