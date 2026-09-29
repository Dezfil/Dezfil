import type { AccountScope } from "@/lib/auth/scope";
import { requireMap } from "./map-access";
import { metadataDb } from "@/lib/metadata/db";
import { renameSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dataDir } from "@/lib/config";

/**
 * Map thumbnails: PNGs per map, captured by the builder after edits
 * settle. Files, not rows — existence is the whole state, and a missing
 * file simply means the card shows its placeholder.
 *
 * By theme: a map whose basemap follows the theme carries one image per
 * theme; every other map keeps its single image. A map is single or
 * themed, never mixed — but only once a replacement set is complete. The
 * single image keeps its historical name, `<id>.png`. A themed image is
 * written under its cycle, `<id>.<cycle>.<theme>.png`, and is *held*
 * until the other theme arrives under the same cycle; the pair is then
 * published by one atomic switch — the map's manifest, `<id>.json`,
 * naming the two files, written whole and renamed into place — so a
 * failure anywhere in a publication leaves the previous
 * set intact and referenced, never a half-replaced pair. Everything the
 * new manifest does not name is then retired: the single file, the
 * previous set's files, every other held write. A cycle that never
 * completes leaves the map's images untouched; its held file expires on
 * the map's next themed write.
 *
 * Every mutation of one map's images runs under that map's own turn, so two cycles cannot interleave. Writes land through
 * a temporary file and a rename (the ` ` class).
 */

export type ThumbnailTheme = "light" | "dark";

export const THUMBNAIL_THEMES: readonly ThumbnailTheme[] = ["light", "dark"];

export function isThumbnailTheme(value: unknown): value is ThumbnailTheme {
  return value === "light" || value === "dark";
}

/** A cycle token is client-minted and becomes part of a file name. */
const CYCLE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export function isThumbnailCycle(value: unknown): value is string {
  return typeof value === "string" && CYCLE_SHAPE.test(value);
}

/** How long a held write may wait for its partner. The ground gives up
 * after twenty seconds and the floor between grounds is ten, so a file
 * older than this belongs to a cycle nothing will complete. */
const PENDING_TTL_MS = 2 * 60_000;

/** One turn at a time per map: every mutation queues behind the last. */
const turns = new Map<string, Promise<unknown>>();

async function inTurn<T>(mapId: string, work: () => Promise<T>): Promise<T> {
  const previous = turns.get(mapId) ?? Promise.resolve();
  const mine = previous.catch(() => undefined).then(work);
  turns.set(mapId, mine);
  try {
    return await mine;
  } finally {
    if (turns.get(mapId) === mine) turns.delete(mapId);
  }
}

function thumbnailsDir(): string {
  return path.join(dataDir(), "thumbnails");
}

/** The single image's file: the historical name. */
export function thumbnailPath(mapId: string): string {
  return path.join(thumbnailsDir(), `${mapId}.png`);
}

/** The manifest naming a themed map's published pair. */
export function thumbnailManifestPath(mapId: string): string {
  return path.join(thumbnailsDir(), `${mapId}.json`);
}

/** One theme's file under its cycle: held until published by the manifest. */
export function thumbnailSetFile(
  mapId: string,
  cycle: string,
  theme: ThumbnailTheme,
): string {
  return `${mapId}.${cycle}.${theme}.png`;
}

/** The published pair, by file name within the thumbnails directory. */
export interface ThumbnailSet {
  light: string;
  dark: string;
}

const otherTheme = (theme: ThumbnailTheme): ThumbnailTheme =>
  theme === "light" ? "dark" : "light";

/** Write whole, then rename into place: a reader never sees a partial file. */
async function writeAtomically(target: string, bytes: Uint8Array | string, authorize: () => void) {
  await mkdir(path.dirname(target), { recursive: true });
  authorize();
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, bytes);
    // Authorization and publication share one event-loop turn.
    authorize();
    renameSync(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The map's published set, or null when it has none (a single image,
 * a legacy image, or nothing). A manifest that cannot be read or does
 * not name two files reads as none. */
async function readSet(mapId: string): Promise<ThumbnailSet | null> {
  try {
    const parsed = JSON.parse(
      await readFile(thumbnailManifestPath(mapId), "utf8"),
    ) as Partial<ThumbnailSet>;
    if (typeof parsed.light !== "string" || typeof parsed.dark !== "string") {
      return null;
    }
    const lightCycle = parsed.light.slice(mapId.length + 1, -".light.png".length);
    const darkCycle = parsed.dark.slice(mapId.length + 1, -".dark.png".length);
    if (!isThumbnailCycle(lightCycle) || lightCycle !== darkCycle ||
      parsed.light !== thumbnailSetFile(mapId, lightCycle, "light") ||
      parsed.dark !== thumbnailSetFile(mapId, darkCycle, "dark")) return null;
    return { light: parsed.light, dark: parsed.dark };
  } catch {
    return null;
  }
}

/** Every themed file of the map, published or held, by name. */
async function themedFiles(mapId: string): Promise<string[]> {
  const shape = new RegExp(
    `^${mapId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[A-Za-z0-9_-]+\\.(light|dark)\\.png$`,
  );
  try {
    return (await readdir(thumbnailsDir())).filter((name) => shape.test(name));
  } catch {
    return [];
  }
}

const inDir = (name: string) => path.join(thumbnailsDir(), name);

/** Remove every themed file the set does not name. */
async function retireUnreferenced(
  mapId: string,
  keep: ThumbnailSet | null,
): Promise<void> {
  const kept = new Set(keep ? [keep.light, keep.dark] : []);
  await Promise.all(
    (await themedFiles(mapId))
      .filter((name) => !kept.has(name))
      .map((name) => rm(inDir(name), { force: true })),
  );
}

/** Held files older than the TTL: abandoned, removed. */
async function expireHeld(
  mapId: string,
  keep: ThumbnailSet | null,
  now = Date.now(),
): Promise<void> {
  const kept = new Set(keep ? [keep.light, keep.dark] : []);
  await Promise.all(
    (await themedFiles(mapId))
      .filter((name) => !kept.has(name))
      .map(async (name) => {
        try {
          const { mtimeMs } = await stat(inDir(name));
          if (now - mtimeMs > PENDING_TTL_MS) await rm(inDir(name), { force: true });
        } catch {
          // Gone already.
        }
      }),
  );
}

/** The single image: published at once under its historical name, and
 * the map returns to one image. */
export function saveThumbnail(
  scope: AccountScope,
  mapId: string,
  bytes: Uint8Array,
): Promise<void> {
  const authorize = () => { requireMap(scope, mapId); };
  authorize();
  return inTurn(mapId, async () => {
    authorize();
    await writeAtomically(thumbnailPath(mapId), bytes, authorize);
    await rm(thumbnailManifestPath(mapId), { force: true });
    await retireUnreferenced(mapId, null);
  });
}

/**
 * One theme's image under a cycle. Held until the other theme arrives
 * under the same cycle; the pair is then published as one set by the
 * manifest switch, and everything the map had before is retired.
 */
export function saveThemedThumbnail(
  scope: AccountScope,
  mapId: string,
  theme: ThumbnailTheme,
  cycle: string,
  bytes: Uint8Array,
): Promise<"held" | "published"> {
  const authorize = () => { requireMap(scope, mapId); };
  authorize();
  return inTurn(mapId, async () => {
    authorize();
    const previous = await readSet(mapId);
    authorize();
    await expireHeld(mapId, previous);
    const own = thumbnailSetFile(mapId, cycle, theme);
    await writeAtomically(inDir(own), bytes, authorize);
    const partner = thumbnailSetFile(mapId, cycle, otherTheme(theme));
    const paired = await exists(inDir(partner));
    authorize();
    if (!paired) return "held";
    // The switch: one rename, after which the new pair is the map's set
    // and the previous one is not. Nothing before it changes a read;
    // a failure here leaves the previous set exactly as it was.
    const next: ThumbnailSet =
      theme === "light" ? { light: own, dark: partner } : { light: partner, dark: own };
    await writeAtomically(thumbnailManifestPath(mapId), JSON.stringify(next), authorize);
    await rm(thumbnailPath(mapId), { force: true });
    await retireUnreferenced(mapId, next);
    return "published";
  });
}

/**
 * The image for a theme, or for none. A themed read prefers its own
 * theme's file in the published set, then the single image, then the
 * other theme's; a read naming no theme prefers the set's light, then
 * its dark, then the single image (so a legacy or single map answers
 * as it always did). Null when the map has no image at all — the route
 * refuses, the card draws its placeholder.
 */
export async function readThumbnail(
  scope: AccountScope,
  mapId: string,
  theme?: ThumbnailTheme | null,
): Promise<Buffer | null> {
  requireMap(scope, mapId);
  const set = await readSet(mapId);
  const single = thumbnailPath(mapId);
  const order = theme
    ? [set ? inDir(set[theme]) : null, single, set ? inDir(set[otherTheme(theme)]) : null]
    : [set ? inDir(set.light) : null, set ? inDir(set.dark) : null, single];
  for (const file of order) {
    if (!file) continue;
    requireMap(scope, mapId);
    let bytes: Buffer | undefined;
    try { bytes = await readFile(file); } catch { /* Try the next name. */ }
    requireMap(scope, mapId);
    if (bytes) return bytes;
  }
  requireMap(scope, mapId);
  return null;
}

/** Every image the map has, published or held. */
function removeThumbnailFiles(mapId: string, authorize: () => void): Promise<void> {
  return inTurn(mapId, async () => {
    authorize();
    await rm(thumbnailManifestPath(mapId), { force: true });
    await rm(thumbnailPath(mapId), { force: true });
    await retireUnreferenced(mapId, null);
  });
}

/** Mint cleanup while the parent still exists. The owning delete transaction
 * returns this closure only after committing; it cannot read or publish files. */
export function prepareThumbnailRemoval(scope: AccountScope, mapId: string): () => Promise<void> {
  requireMap(scope, mapId);
  return () => removeThumbnailFiles(mapId, () => {
    // An already committed deletion may finish its cleanup. A live or
    // replaced parent still requires current authority when the turn starts.
    if (metadataDb().prepare("SELECT id FROM maps WHERE id = ?").get(mapId)) requireMap(scope, mapId);
  });
}

export function removeThumbnail(scope: AccountScope, mapId: string): Promise<void> {
  requireMap(scope, mapId);
  return removeThumbnailFiles(mapId, () => { requireMap(scope, mapId); });
}

/** A duplicated map keeps its look until its first capture. Lock both parents
 * in stable order, so a queued destination write cannot interleave the copy. */
export function copyThumbnail(scope: AccountScope, from: string, to: string): Promise<void> {
  const authorize = () => { requireMap(scope, from); requireMap(scope, to); };
  authorize();
  if (from === to) return Promise.resolve();
  const [first, second] = [from, to].sort();
  return inTurn(first, () => inTurn(second, async () => {
    authorize();
    let single: Buffer | undefined;
    try { single = await readFile(thumbnailPath(from)); } catch { /* No single image. */ }
    authorize();
    if (single) await writeAtomically(thumbnailPath(to), single, authorize);
    const set = await readSet(from);
    authorize();
    if (!set) return;
    const copied: ThumbnailSet = {
      light: set.light.replace(from, to),
      dark: set.dark.replace(from, to),
    };
    const light = await readFile(inDir(set.light));
    authorize();
    const dark = await readFile(inDir(set.dark));
    await writeAtomically(inDir(copied.light), light, authorize);
    await writeAtomically(inDir(copied.dark), dark, authorize);
    await writeAtomically(thumbnailManifestPath(to), JSON.stringify(copied), authorize);
  }));
}
