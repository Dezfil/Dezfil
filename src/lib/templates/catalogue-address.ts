import type { Database } from "better-sqlite3";
import path from "node:path";
import { metadataDb } from "@/lib/metadata/db";
import { settingDefinition } from "@/lib/settings/catalogue";
import { isWebAddress } from "@/lib/settings/disclosure";
import { lockedEnvironment, settingEnvironment } from "@/lib/settings/resolver";
import { resolveServiceAddress, type AddressInEffect } from "@/lib/settings/service-address";

/**
 * Where the template catalogue is read now: an address (its variable, else
 * the address an admin stored, else the release catalogue), or a folder on
 * this server, which only its variable may name: anything the variable
 * holds that is not an http or https address, taken from the working
 * directory when relative. A stored address the instance's key no longer
 * opens refuses with the coded unreadable refusal, as every service's does,
 * and never falls back to the release catalogue. Read on each call.
 */
export type CatalogueInEffect =
  | { readonly kind: "address"; readonly address: string; readonly source: AddressInEffect["source"] }
  | { readonly kind: "folder"; readonly folder: string; readonly source: "environment" }
  | { readonly kind: "unset"; readonly source: AddressInEffect["source"] };

export function resolveTemplatesCatalogue(db: Database = metadataDb()): CatalogueInEffect {
  const definition = settingDefinition("templatesCatalogueUrl");
  const variable = lockedEnvironment(definition) ? settingEnvironment(definition)!.trim() : "";
  if (variable && !isWebAddress(variable)) return { kind: "folder", folder: path.resolve(variable), source: "environment" };
  const { address, source } = resolveServiceAddress("templatesCatalogueUrl", db);
  return address === null ? { kind: "unset", source } : { kind: "address", address, source };
}
