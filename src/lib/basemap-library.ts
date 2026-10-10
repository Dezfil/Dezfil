import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { metadataDb } from "@/lib/metadata/db";
import { inspectStyle } from "@/lib/net/inspect-style";
import { egressRefusal } from "@/lib/settings/address-admission";
import { LIBRARY_LIMITS, type AttributionLine, type LibraryStyleOffer } from "./basemap";

/**
 * The instance's basemap library: styles an admin adds by their address, for
 * everyone choosing a basemap.
 *
 * A style is read once, at the add, as a map's own style address is read:
 * the save-time egress check first, so a blocked address is refused with
 * the check's sentence before anything is sent, then one inspection through
 * the style inspector within its time and size bounds, keeping the style's
 * credit, else its host. Only a style this server can read now is added (an
 * offered style must draw in the server's images too); nothing reads it
 * again. A map that takes one keeps its own copy, so hiding or removing a
 * row changes no map. Admins add, offer, hide and remove, rechecked inside
 * each write.
 */

export interface LibraryStyle extends LibraryStyleOffer {
  /** Whether the style is offered where a basemap is chosen. */
  offered: boolean;
  addedAt: string;
}

interface Row { id: string; name: string; url: string; attribution: string; offered: number; created_at: string }

const fromRow = (row: Row): LibraryStyle => ({
  id: row.id, name: row.name, url: row.url, attribution: JSON.parse(row.attribution) as AttributionLine[],
  offered: row.offered === 1, addedAt: row.created_at,
});

const invalid = (message: string): ApiError => new ApiError("invalid_request", message, 400);

/** Every style in the library, hidden ones included, oldest first. */
export function listLibraryStyles(db: Database = metadataDb()): LibraryStyle[] {
  return (db.prepare("SELECT * FROM basemap_styles ORDER BY position").all() as Row[]).map(fromRow);
}

/** The styles a person may choose: name, address and credit. */
export function offeredLibraryStyles(db: Database = metadataDb()): LibraryStyleOffer[] {
  return listLibraryStyles(db).filter((style) => style.offered)
    .map(({ id, name, url, attribution }) => ({ id, name, url, attribution }));
}

/** One style, or null. */
export function libraryStyle(id: string, db: Database = metadataDb()): LibraryStyle | null {
  const row = db.prepare("SELECT * FROM basemap_styles WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** An add's name and address, as given, or the refusal naming what is wrong. */
export function admitStyleInput(input: unknown): { name: string; url: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "name" && key !== "url")) {
    throw invalid("Give the style's name and its url, and nothing else.");
  }
  const { name, url } = input as Record<string, unknown>;
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName || trimmedName.length > LIBRARY_LIMITS.name) {
    throw invalid(`name must be 1 to ${LIBRARY_LIMITS.name} characters.`);
  }
  const address = typeof url === "string" ? url.trim() : "";
  if (address.length > LIBRARY_LIMITS.address) {
    throw invalid(`url must be at most ${LIBRARY_LIMITS.address.toLocaleString("en-US")} characters.`);
  }
  let parsed: URL | null = null;
  try { parsed = new URL(address); } catch { /* refused below */ }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw invalid("url must be an http or https address with a host.");
  }
  return { name: trimmedName, url: address };
}

/** Refuse an address the library holds, and a style past its most. */
function requireRoom(url: string, db: Database): void {
  if (db.prepare("SELECT 1 FROM basemap_styles WHERE url = ?").get(url)) {
    throw invalid("The library already holds a style at this address.");
  }
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM basemap_styles").get() as { count: number };
  if (count >= LIBRARY_LIMITS.styles) {
    throw invalid(`The library holds ${LIBRARY_LIMITS.styles} styles, its most. Remove one before adding another.`);
  }
}

export interface AddStyleDeps {
  inspect?: typeof inspectStyle;
  now?: () => number;
}

/** Add a style by its address, after the one read that checks it. */
export async function addLibraryStyle(context: AuthContext, input: unknown, db: Database = metadataDb(),
  deps: AddStyleDeps = {}): Promise<LibraryStyle> {
  const { name, url } = admitStyleInput(input);
  const now = deps.now ?? Date.now;
  db.transaction(() => { requireAdmin(context, db, now()); requireRoom(url, db); }).immediate();
  // The save-time check, as a stored address takes it: nothing is sent to an
  // address it refuses, and its sentence names no part of the address.
  const refusal = await egressRefusal(url);
  if (refusal) throw invalid(refusal);
  const inspection = await (deps.inspect ?? inspectStyle)(url);
  if (inspection.verdict === "blocked") throw invalid(inspection.detail);
  if (inspection.verdict === "not_style") throw invalid(`The address did not answer with a MapLibre style. ${inspection.detail}`);
  if (inspection.verdict === "unreachable") {
    // The fetch's own words may repeat the address; a status may not.
    const status = /^HTTP \d{3}\.$/.test(inspection.detail) ? ` It answered ${inspection.detail}` : "";
    throw invalid(`The style could not be read now, so it was not added.${status} The library takes only a style this server can read.`);
  }
  const attribution = inspection.attribution.length ? inspection.attribution : [{ label: new URL(url).hostname }];
  return db.transaction(() => {
    requireAdmin(context, db, now());
    // Checked again: another add may have taken the address or the last place meanwhile.
    requireRoom(url, db);
    const id = randomUUID();
    // Its place in the list: after every style added before it.
    const { last } = db.prepare("SELECT COALESCE(MAX(position), 0) AS last FROM basemap_styles").get() as { last: number };
    db.prepare("INSERT INTO basemap_styles (id, name, url, attribution, offered, position, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .run(id, name, url, JSON.stringify(attribution), last + 1, new Date(now()).toISOString());
    return libraryStyle(id, db)!;
  }).immediate();
}

/** Offer or hide an added style where a basemap is chosen. */
export function setLibraryStyleOffered(context: AuthContext, id: string, input: unknown, db: Database = metadataDb(),
  now = Date.now()): LibraryStyle {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
      typeof (input as { offered?: unknown }).offered !== "boolean") {
    throw invalid("Give offered as true or false, and nothing else.");
  }
  const offered = (input as { offered: boolean }).offered;
  return db.transaction(() => {
    requireAdmin(context, db, now);
    if (!libraryStyle(id, db)) throw new ApiError("not_found", "There is no such style in the library.", 404);
    db.prepare("UPDATE basemap_styles SET offered = ? WHERE id = ?").run(offered ? 1 : 0, id);
    return libraryStyle(id, db)!;
  }).immediate();
}

/** Remove an added style. Maps that took it keep their copy. */
export function removeLibraryStyle(context: AuthContext, id: string, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => {
    requireAdmin(context, db, now);
    if (db.prepare("DELETE FROM basemap_styles WHERE id = ?").run(id).changes === 0) {
      throw new ApiError("not_found", "There is no such style in the library.", 404);
    }
    return { removed: true as const };
  }).immediate();
}
