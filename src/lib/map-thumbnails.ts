import type { AccountScope } from "@/lib/auth/scope";
import { requireMap, requireOwnMap } from "./map-access";
import { servableTo } from "./artifact-access";
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
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { evidencedImages, imageInputs, removeImageEvidence, writeImageEvidence } from "./thumbnail-evidence";

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
 *
 * Each image carries the evidence of what it drew (thumbnail-evidence.ts),
 * written before the image and removed with it. Captures are the map
 * owner's; an image is served, and copied into a duplicate, only for
 * someone who reaches the map and can now reach every dataset it drew, an
 * unattributed image for the map's owner alone.
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
const turnsKey = Symbol.for("dezfil.thumbnail-turns");
const turnsHost = globalThis as typeof globalThis & { [turnsKey]?: Map<string, Promise<unknown>> };
const turns = turnsHost[turnsKey] ??= new Map<string, Promise<unknown>>();

export async function inThumbnailTurn<T>(mapId: string, work: () => Promise<T>): Promise<T> {
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

/** Remove an image and the evidence of what it drew. */
async function removeImage(name: string): Promise<void> {
  await rm(inDir(name), { force: true });
  await removeImageEvidence(name);
}

/** Remove every themed file the set does not name, and every piece of
 * evidence that no longer has its image. */
async function retireUnreferenced(
  mapId: string,
  keep: ThumbnailSet | null,
  single = false,
): Promise<void> {
  const kept = new Set(keep ? [keep.light, keep.dark] : []);
  if (single) kept.add(path.basename(thumbnailPath(mapId)));
  await Promise.all(
    (await themedFiles(mapId))
      .filter((name) => !kept.has(name))
      .map(removeImage),
  );
  await Promise.all(
    (await evidencedImages(mapId))
      .filter((name) => !kept.has(name))
      .map(removeImageEvidence),
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
          if (now - mtimeMs > PENDING_TTL_MS) await removeImage(name);
        } catch {
          // Gone already.
        }
      }),
  );
}

/** The single image: published at once under its historical name, and
 * the map returns to one image. `inputs` is what the image drew, or null
 * for an unattributed image. */
export function saveThumbnail(
  scope: AccountScope,
  mapId: string,
  bytes: Uint8Array,
  inputs: ArtifactInputs | null = null,
): Promise<void> {
  const authorize = () => { requireOwnMap(scope, mapId); };
  authorize();
  return inThumbnailTurn(mapId, async () => {
    authorize();
    const single = path.basename(thumbnailPath(mapId));
    await writeImageEvidence(single, bytes, inputs);
    await writeAtomically(thumbnailPath(mapId), bytes, authorize);
    await rm(thumbnailManifestPath(mapId), { force: true });
    await retireUnreferenced(mapId, null, true);
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
  inputs: ArtifactInputs | null = null,
): Promise<"held" | "published"> {
  const authorize = () => { requireOwnMap(scope, mapId); };
  authorize();
  return inThumbnailTurn(mapId, async () => {
    authorize();
    const previous = await readSet(mapId);
    authorize();
    await expireHeld(mapId, previous);
    const own = thumbnailSetFile(mapId, cycle, theme);
    await writeImageEvidence(own, bytes, inputs);
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
    await removeImage(path.basename(thumbnailPath(mapId)));
    await retireUnreferenced(mapId, next);
    return "published";
  });
}

/**
 * The image for a theme, or for none. A themed read prefers its own
 * theme's file in the published set, then the single image, then the
 * other theme's; a read naming no theme prefers the set's light, then
 * its dark, then the single image (so a legacy or single map answers
 * as it always did). An image the reader may not be served is passed
 * over like a missing one. Null when nothing is left — the route
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
    if (bytes && servableTo(scope, mapId, await imageInputs(path.basename(file), bytes))) return bytes;
  }
  requireMap(scope, mapId);
  return null;
}

/** Every image the map has, published or held. */
function removeThumbnailFiles(mapId: string, authorize: () => void): Promise<void> {
  return inThumbnailTurn(mapId, async () => {
    authorize();
    await rm(thumbnailManifestPath(mapId), { force: true });
    await removeImage(path.basename(thumbnailPath(mapId)));
    await retireUnreferenced(mapId, null);
  });
}

/** Mint cleanup while the parent still exists. The owning delete transaction
 * returns this closure only after committing; it cannot read or publish files. */
export function prepareThumbnailRemoval(scope: AccountScope, mapId: string): () => Promise<void> {
  requireOwnMap(scope, mapId);
  return () => removeThumbnailFiles(mapId, () => {
    // An already committed deletion may finish its cleanup. A live or
    // replaced parent still requires current authority when the turn starts.
    if (metadataDb().prepare("SELECT id FROM maps WHERE id = ?").get(mapId)) requireOwnMap(scope, mapId);
  });
}

export function removeThumbnail(scope: AccountScope, mapId: string): Promise<void> {
  requireOwnMap(scope, mapId);
  return removeThumbnailFiles(mapId, () => { requireOwnMap(scope, mapId); });
}

/** A duplicated map keeps its look until its first capture, each image with
 * the evidence of what it drew: the copy keeps the original's SQL and home.
 * An image is copied only when the duplicator may be served it now, a
 * themed pair only whole; otherwise the copy starts without it. Lock both
 * parents in stable order, so a queued destination write cannot interleave
 * the copy. */
export function copyThumbnail(scope: AccountScope, from: string, to: string): Promise<void> {
  const authorize = () => { requireMap(scope, from); requireOwnMap(scope, to); };
  authorize();
  if (from === to) return Promise.resolve();
  const [first, second] = [from, to].sort();
  return inThumbnailTurn(first, () => inThumbnailTurn(second, async () => {
    authorize();
    let single: Buffer | undefined;
    try { single = await readFile(thumbnailPath(from)); } catch { /* No single image. */ }
    authorize();
    const singleInputs = single ? await imageInputs(path.basename(thumbnailPath(from)), single) : null;
    if (single && servableTo(scope, from, singleInputs)) {
      await writeImageEvidence(path.basename(thumbnailPath(to)), single, singleInputs);
      await writeAtomically(thumbnailPath(to), single, authorize);
    }
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
    const lightInputs = await imageInputs(set.light, light);
    const darkInputs = await imageInputs(set.dark, dark);
    if (!servableTo(scope, from, lightInputs) || !servableTo(scope, from, darkInputs)) return;
    await writeImageEvidence(copied.light, light, lightInputs);
    await writeImageEvidence(copied.dark, dark, darkInputs);
    await writeAtomically(inDir(copied.light), light, authorize);
    await writeAtomically(inDir(copied.dark), dark, authorize);
    await writeAtomically(thumbnailManifestPath(to), JSON.stringify(copied), authorize);
  }));
}

export function thumbnailMutationIds(): string[] { return [...turns.keys()]; }
export function thumbnailTurnForTests(mapId: string): Promise<unknown> | undefined { return turns.get(mapId); }
