import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { settingDefinition } from "./catalogue";
import { readDeploymentSetting } from "./deployment-read";
import { discloseAddress } from "./disclosure";
import { lockedEnvironment, settingEnvironment } from "./resolver";
import { readStoredAddress } from "./store";
import type { ServiceAddressKey, SettingDefinition } from "./types";

/**
 * The four services whose address an admin may store beside its variable:
 * the address finder, travel time, OpenStreetMap's Overpass server and the
 * S3 address for `s3://` links.
 *
 * This module is the only caller of the store's door to a stored address's
 * plaintext. A service takes its address in effect from here, and the
 * configuration read takes what it may say about one (scheme and host, or
 * set and unreadable) from here; nothing else reads a stored address.
 */
export const SERVICE_ADDRESS_KEYS = ["geocoderUrl", "isochroneUrl", "overpassUrl", "s3Endpoint"] as const satisfies readonly ServiceAddressKey[];
export type { ServiceAddressKey };

export interface AddressInEffect {
  /** What the service reaches, or null for its own road without one: no
   * address finder, no travel time, Amazon S3's own addresses. */
  readonly address: string | null;
  readonly source: "environment" | "stored" | "default";
}

/** A stored address the instance's key no longer opens. Its service refuses
 * rather than reach a default nobody chose; the address is never named. */
export function serviceAddressUnreadable(key: ServiceAddressKey): ApiError {
  const { label } = settingDefinition(key);
  return new ApiError("service_address_unreadable",
    `The saved address for "${label}" cannot be read with this instance's encryption key, which changed after it was saved. ` +
    "An admin can save the address again.", 400);
}

const defaultAddress = (definition: SettingDefinition) =>
  typeof definition.defaultValue === "string" ? definition.defaultValue : null;

/**
 * The address a service uses now: its variable when set, else the stored
 * address, else the default. A stored address that cannot be read refuses
 * with a coded error and never falls back to the default. Read on each call:
 * a caller that must keep one address for a whole run captures it once.
 */
export function resolveServiceAddress(key: ServiceAddressKey, db: Database = metadataDb()): AddressInEffect {
  const definition = settingDefinition(key);
  if (lockedEnvironment(definition)) {
    return { address: settingEnvironment(definition)!.trim() || defaultAddress(definition), source: "environment" };
  }
  const stored = readStoredAddress(key, db);
  if (!stored.set) return { address: defaultAddress(definition), source: "default" };
  if ("unreadable" in stored) throw serviceAddressUnreadable(key);
  return { address: stored.address, source: "stored" };
}

/** Whether the service has an address now: its variable, a stored address
 * (readable or not: an unreadable one is set, and its service refuses), or
 * a default. Never the address itself. */
export function serviceAddressConfigured(key: ServiceAddressKey, db: Database = metadataDb()): boolean {
  try { return resolveServiceAddress(key, db).address !== null; }
  catch (error) {
    if (error instanceof ApiError && error.code === "service_address_unreadable") return true;
    throw error;
  }
}

/** What may be said about an address anywhere: its scheme and host (with a
 * port when it has one), or null for text that is not an address. Never
 * its user information, path, query or fragment. */
export function addressOrigin(address: string): string | null {
  const disclosed = discloseAddress(address);
  return "origin" in disclosed ? disclosed.origin : null;
}

/** The configuration read's entry for a service address: the variable's
 * disclosure while it locks the row, else the stored address as scheme and
 * host (or set and unreadable), else the default's. What was stored is
 * never given back, so storedValue is always null. */
export function serviceAddressSetting(definition: SettingDefinition, db: Database) {
  if (lockedEnvironment(definition)) return readDeploymentSetting(definition);
  const stored = readStoredAddress(definition.key, db);
  if (!stored.set) return readDeploymentSetting(definition);
  return { value: "unreadable" in stored ? { set: true as const, unreadable: true as const } : discloseAddress(stored.address),
    source: "stored" as const, locked: false, invalidOverride: false, storedValue: null };
}
