import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { pictureWorkScope } from "@/lib/auth/scope";
import { delegatedWorkKey } from "@/lib/auth/account-deletion-work";
import { AuthError } from "@/lib/auth/errors";
import { isAnonymousAsset } from "@/lib/auth/public-assets";
export const PICTURE_WORK_HEADER = "x-dezfil-picture-work";
const refused = () => new AuthError("authentication_required", "Sign in to continue.", 401);

/** Internal worker mint. There is no HTTP operation accepting an owner or
 * asking for this credential. Only a hash survives in the attempt's row. */
export function mintPictureCredential(mapId: string, expiresAt: number, db: Database = metadataDb()): string {
  const secret = `dz_picture_${randomBytes(32).toString("hex")}`;
  const changed = db.prepare(`UPDATE map_pictures SET work_key = ?, work_expires_at = ?, work_inputs = NULL,
    work_owner = (SELECT owner_id FROM maps WHERE id = ?)
    WHERE map_id = ? AND EXISTS (SELECT 1 FROM maps m JOIN accounts a ON a.id = m.owner_id WHERE m.id = ? AND a.status = 'active')`)
    .run(delegatedWorkKey(secret), expiresAt, mapId, mapId, mapId).changes;
  if (!changed) throw refused();
  return secret;
}
export function revokePictureCredential(secret: string, db: Database = metadataDb()): void {
  db.prepare("UPDATE map_pictures SET work_key = NULL, work_owner = NULL, work_expires_at = NULL, work_inputs = NULL WHERE work_key = ?").run(delegatedWorkKey(secret));
}

/** Reads only, bounded by resource identity rather than a URL prefix. */
export function pictureRequestScope(request: Request, db: Database = metadataDb(), now = Date.now()) {
  const secret = request.headers.get(PICTURE_WORK_HEADER);
  if (secret === null) return null;
  const { scope, mapId } = pictureWorkScope(secret, db, now);
  if (request.method !== "GET" && request.method !== "HEAD") throw refused();
  const path = new URL(request.url).pathname;
  if (path === `/render/${encodeURIComponent(mapId)}` || path === `/api/maps/${encodeURIComponent(mapId)}`) return scope;
  const layer = /^\/api\/layers\/([^/]+)(?:\/render|\/tiles\/\d+\/\d+\/\d+)?$/.exec(path);
  if (layer) {
    const row = db.prepare("SELECT map_id FROM layers WHERE id = ?").get(decodeURIComponent(layer[1])) as { map_id: string } | undefined;
    if (row?.map_id === mapId) return scope;
  }
  // The map's configured imagery uses this instance's read-only proxy.
  if (/^\/api\/basemaps\/satellite(?:\/tiles\/\d+\/\d+\/\d+)?$/.test(path)) {
    const row = db.prepare("SELECT basemap, custom_basemap FROM maps WHERE id = ?").get(mapId) as { basemap: string | null; custom_basemap: string | null };
    if (row.basemap === "satellite" && !row.custom_basemap) return scope;
  }
  if (isAnonymousAsset(path, request.method, process.env.NODE_ENV === "development")) return scope;
  throw refused();
}

/** Only the in-process owner of an attempt renews it after slot admission. */
export function renewPictureCredential(secret: string, expiresAt: number, db: Database = metadataDb()): void {
  const changed = db.prepare(`UPDATE map_pictures SET work_expires_at = ? WHERE work_key = ?
    AND EXISTS (SELECT 1 FROM maps m JOIN accounts a ON a.id = m.owner_id
      WHERE m.id = map_pictures.map_id AND m.owner_id = map_pictures.work_owner AND a.status = 'active')`)
    .run(expiresAt, delegatedWorkKey(secret)).changes;
  if (!changed) throw refused();
}
