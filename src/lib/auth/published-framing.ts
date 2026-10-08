import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { settingDefinition } from "@/lib/settings/catalogue";
import { readStoredSettings } from "@/lib/settings/store";

/**
 * The framing policy a published page answers with, from the embedding rows
 * as they are stored now: none under Any site, so any site may show the page
 * as before; exactly the listed sites under Listed sites; no site under Off.
 * Read from the store on every answer and kept nowhere, so a save applies to
 * every published page from its next load without a restart. The sites are
 * stored as scheme, host and optional port alone, so each is a source the
 * policy can name as it is.
 */
export function publishedFramingPolicy(db: Database = metadataDb()): string | null {
  const stored = readStoredSettings(db);
  const embedding = stored["publishing.embedding"] ?? settingDefinition("publishing.embedding").defaultValue;
  if (embedding === "listed") {
    const sites = stored["publishing.embedSites"];
    // The change operation refuses Listed with no site; a store that holds
    // one anyway admits none rather than every site.
    return `frame-ancestors ${Array.isArray(sites) && sites.length ? sites.join(" ") : "'none'"}`;
  }
  if (embedding === "off") return "frame-ancestors 'none'";
  return null;
}
