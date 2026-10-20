import { admitResourceWork, bindDeletionDatasets, inDeletionWork, observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
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
import type { DrawnBasemap } from "./picture-credit";
import { PICTURE_SHAPE_NAMES, keptWidth, type PictureShape } from "./pictures/shapes";
import type { PictureImages } from "./pictures/card";
import {
  evidencedImages,
  imageEvidence,
  imageInputs,
  recordedEvidence,
  removeImageEvidence,
  writeImageEvidence,
  type ImageEvidence,
} from "./thumbnail-evidence";

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
 * Each image carries the evidence of what it drew and the basemap it was
 * drawn on (thumbnail-evidence.ts), written before the image and removed
 * with it. Captures are the map
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
const begunKey = Symbol.for("dezfil.thumbnail-turns-begun");
const turnsHost = globalThis as typeof globalThis & {
  [turnsKey]?: Map<string, Promise<unknown>>;
  [begunKey]?: { count: number };
};
const turns = turnsHost[turnsKey] ??= new Map<string, Promise<unknown>>();
/** Mutation turns begun on any map: a read that saw none begin, and none
 * pending on its map, saw no mutation while it ran. */
const begun = turnsHost[begunKey] ??= { count: 0 };

export function inThumbnailTurn<T>(mapId: string, work: () => Promise<T>): Promise<T> {
  return queueTurn(mapId, () => {
    begun.count += 1;
    return work();
  });
}

async function queueTurn<T>(mapId: string, work: () => Promise<T>): Promise<T> {
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

/** The published pair, by file name within the thumbnails directory. A
 * server picture made with kept sizes lists them: each is a WebP file
 * beside its PNG under the same publication name, and is that picture
 * for serving. A set without sizes is an older picture. */
export interface ThumbnailSet {
  light: string;
  dark: string;
  sizes?: Record<PictureShape, number[]>;
}

/** A kept size's file, beside the PNG it belongs to. */
export function sizedPictureFile(png: string, shape: PictureShape, width: number): string {
  return png.replace(/\.png$/, `.${shape}-${width}.webp`);
}

/** Every file a set names: its PNGs and their kept sizes. */
function setFiles(set: ThumbnailSet): string[] {
  const pngs = [...new Set([set.light, set.dark])];
  const sizes = set.sizes;
  return pngs.flatMap((png) => [
    png,
    ...(sizes ? PICTURE_SHAPE_NAMES.flatMap((shape) => sizes[shape].map((width) => sizedPictureFile(png, shape, width))) : []),
  ]);
}

function readSizes(raw: unknown): Record<PictureShape, number[]> | undefined | null {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") return null;
  const sizes = {} as Record<PictureShape, number[]>;
  for (const shape of PICTURE_SHAPE_NAMES) {
    const widths = (raw as Record<string, unknown>)[shape];
    if (!Array.isArray(widths) || widths.length === 0 || !widths.every((w) => Number.isInteger(w) && w > 0)) return null;
    sizes[shape] = [...widths].sort((a, b) => a - b);
  }
  return sizes;
}

const otherTheme = (theme: ThumbnailTheme): ThumbnailTheme =>
  theme === "light" ? "dark" : "light";

/** Write whole, then rename into place: a reader never sees a partial file. */
async function writeAtomically(target: string, bytes: Uint8Array | string, authorize: () => void, published?: () => void) {
  await mkdir(path.dirname(target), { recursive: true });
  authorize();
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, bytes);
    // Authorization and publication share one event-loop turn.
    authorize();
    renameSync(temp, target);
    published?.();
  } catch (error) {
    await observeDeletionCleanup(() => rm(temp, { force: true }));
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
    ) as Partial<Omit<ThumbnailSet, "sizes">> & { sizes?: unknown };
    if (typeof parsed.light !== "string" || typeof parsed.dark !== "string") {
      return null;
    }
    const sizes = readSizes(parsed.sizes);
    if (sizes === null) return null;
    const listed = sizes ? { sizes } : {};
    const lightCycle = parsed.light.slice(mapId.length + 1, -".light.png".length);
    if (parsed.dark === parsed.light && isThumbnailCycle(lightCycle) && parsed.light === thumbnailSetFile(mapId, lightCycle, "light")) return { light: parsed.light, dark: parsed.dark, ...listed };
    const darkCycle = parsed.dark.slice(mapId.length + 1, -".dark.png".length);
    if (!isThumbnailCycle(lightCycle) || lightCycle !== darkCycle ||
      parsed.light !== thumbnailSetFile(mapId, lightCycle, "light") ||
      parsed.dark !== thumbnailSetFile(mapId, darkCycle, "dark")) return null;
    return { light: parsed.light, dark: parsed.dark, ...listed };
  } catch {
    return null;
  }
}

/** Every themed file of the map, published or held, by name: its PNGs
 * and their kept sizes. */
async function themedFiles(mapId: string): Promise<string[]> {
  const shape = new RegExp(
    `^${mapId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[A-Za-z0-9_-]+\\.(light|dark)\\.(png|(card|wide)-[0-9]+\\.webp)$`,
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
  const kept = new Set(keep ? setFiles(keep) : []);
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
  const kept = new Set(keep ? setFiles(keep) : []);
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
 * for an unattributed image; `basemap` the basemap it was drawn on, or
 * null when none is known. */
export function saveThumbnail(
  scope: AccountScope,
  mapId: string,
  bytes: Uint8Array,
  inputs: ArtifactInputs | null = null,
  basemap: DrawnBasemap | null = null,
): Promise<void> {
  requireOwnMap(scope, mapId);
  const lease = admitResourceWork(scope, [{ table: "maps", id: mapId }]);
  const authorize = () => { requireOwnMap(scope, mapId); lease.assertCommit(); };
  try { inDeletionWork(lease, () => bindDeletionDatasets(inputs?.datasets.map(input => input.id) ?? [])); }
  catch (error) { lease.release(); throw error; }
  return inDeletionWork(lease, () => inThumbnailTurn(mapId, async () => {
    authorize();
    const single = path.basename(thumbnailPath(mapId));
    await writeImageCandidate(single, thumbnailPath(mapId), bytes, { inputs, basemap }, authorize);
    await rm(thumbnailManifestPath(mapId), { force: true });
    await retireUnreferenced(mapId, null, true);
  })).finally(() => lease.release());
}

async function writeImageCandidate(image: string, target: string, bytes: Uint8Array, evidence: ImageEvidence, authorize: () => void) {
  let previous: Buffer | undefined;
  try { previous = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const previousEvidence = previous ? await imageEvidence(image, previous) : null;
  try {
    await writeImageEvidence(image, bytes, evidence, authorize);
    await writeAtomically(target, bytes, authorize);
  } catch (error) {
    if (previous) await writeImageEvidence(image, previous, previousEvidence!);
    else await removeImageEvidence(image);
    throw error;
  }
}

/**
 * A cycle publishes once. A write under the cycle of the published pair
 * would overwrite a file the live manifest names, so the pair first
 * moves to fresh names by the same switch, bytes and evidence unchanged,
 * and the write is then held like any other. A failure before the
 * switch leaves the pair where it was; a pair already missing a file
 * has nothing whole to keep and stays as it is.
 */
async function moveAside(mapId: string, set: ThumbnailSet, authorize: () => void): Promise<ThumbnailSet> {
  const images: Partial<Record<ThumbnailTheme, Buffer>> = {};
  for (const theme of THUMBNAIL_THEMES) {
    try {
      images[theme] = await readFile(inDir(set[theme]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return set;
      throw error;
    }
  }
  const cycle = randomBytes(12).toString("hex");
  const moved: ThumbnailSet = {
    light: thumbnailSetFile(mapId, cycle, "light"),
    dark: thumbnailSetFile(mapId, cycle, "dark"),
  };
  for (const theme of THUMBNAIL_THEMES) {
    const bytes = images[theme]!;
    await writeImageEvidence(moved[theme], bytes, await imageEvidence(set[theme], bytes), authorize);
    await writeAtomically(inDir(moved[theme]), bytes, authorize);
  }
  await writeAtomically(thumbnailManifestPath(mapId), JSON.stringify(moved), authorize);
  await removeImage(set.light);
  await removeImage(set.dark);
  return moved;
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
  basemap: DrawnBasemap | null = null,
): Promise<"held" | "published"> {
  requireOwnMap(scope, mapId);
  const lease = admitResourceWork(scope, [{ table: "maps", id: mapId }]);
  const authorize = () => { requireOwnMap(scope, mapId); lease.assertCommit(); };
  try { inDeletionWork(lease, () => bindDeletionDatasets(inputs?.datasets.map(input => input.id) ?? [])); }
  catch (error) { lease.release(); throw error; }
  return inDeletionWork(lease, () => inThumbnailTurn(mapId, async () => {
    authorize();
    const own = thumbnailSetFile(mapId, cycle, theme);
    let previous = await readSet(mapId);
    authorize();
    if (previous && (previous.light === own || previous.dark === own)) {
      previous = await moveAside(mapId, previous, authorize);
    }
    await expireHeld(mapId, previous);
    await writeImageCandidate(own, inDir(own), bytes, { inputs, basemap }, authorize);
    const partner = thumbnailSetFile(mapId, cycle, otherTheme(theme));
    const paired = await exists(inDir(partner));
    authorize();
    if (!paired) return "held" as const;
    const partnerInputs = await imageInputs(partner, await readFile(inDir(partner)));
    bindDeletionDatasets(partnerInputs?.datasets.map(input => input.id) ?? []);
    authorize();
    // The switch: one rename, after which the new pair is the map's set
    // and the previous one is not. Nothing before it changes a read;
    // a failure here leaves the previous set exactly as it was.
    const next: ThumbnailSet =
      theme === "light" ? { light: own, dark: partner } : { light: partner, dark: own };
    await writeAtomically(thumbnailManifestPath(mapId), JSON.stringify(next), authorize);
    await removeImage(path.basename(thumbnailPath(mapId)));
    await retireUnreferenced(mapId, next);
    return "published" as const;
  })).finally(() => lease.release());
}

/**
 * The image for a theme, or for none. A themed read prefers its own
 * theme's file in the published set, then the single image, then the
 * other theme's; a read naming no theme prefers the set's light, then
 * its dark, then the single image (so a legacy or single map answers
 * as it always did). An image the reader may not be served is passed
 * over like a missing one. Null when nothing is left — the route
 * refuses, the card draws its placeholder.
 *
 * Reads do not queue behind captures. A publication retires the files
 * the previous manifest named, so a read that overlapped a mutation may
 * hold names that are gone; it is taken again inside the map's turn,
 * where nothing can move under it.
 */
export async function readThumbnail(
  scope: AccountScope,
  mapId: string,
  theme?: ThumbnailTheme | null,
): Promise<Buffer | null> {
  return (await readPicture(scope, mapId, theme))?.bytes ?? null;
}

/** What a picture read may name beyond the theme: a shape, a width in
 * pixels, or both. */
export interface PictureWant {
  shape?: PictureShape;
  width?: number;
}

/** A picture read's answer: the bytes and their format. */
export interface PictureAnswer {
  bytes: Buffer;
  type: "image/png" | "image/webp";
}

/**
 * The picture for a theme, as readThumbnail chooses it, and with a shape
 * or a width named, the kept size of that picture: the narrowest of the
 * shape at least that wide, else the widest; a shape alone its widest, a
 * width alone the card's. The PNG's evidence decides whether any of them
 * is served. A picture without kept sizes answers its PNG whatever is
 * named, as does a set whose size file is missing.
 */
export async function readPicture(
  scope: AccountScope,
  mapId: string,
  theme?: ThumbnailTheme | null,
  want: PictureWant = {},
): Promise<PictureAnswer | null> {
  requireMap(scope, mapId);
  const before = begun.count;
  if (!turns.has(mapId)) {
    const answer = await readPublished(scope, mapId, theme, want);
    if (begun.count === before && !turns.has(mapId)) return answer;
  }
  return queueTurn(mapId, () => readPublished(scope, mapId, theme, want));
}

async function readPublished(
  scope: AccountScope,
  mapId: string,
  theme: ThumbnailTheme | null | undefined,
  want: PictureWant,
): Promise<PictureAnswer | null> {
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
    if (!bytes) continue;
    const inputs = await imageInputs(path.basename(file), bytes);
    if (!servableTo(scope, mapId, inputs)) continue;
    const sized = wantedSize(set, path.basename(file), want);
    if (sized) {
      let kept: Buffer | undefined;
      try { kept = await readFile(inDir(sized)); } catch { /* Answer the PNG. */ }
      // Reach may have changed while the size was read: the same check
      // decides again, for the size and for the PNG in its place.
      requireMap(scope, mapId);
      if (!servableTo(scope, mapId, inputs)) continue;
      if (kept) return { bytes: kept, type: "image/webp" };
    }
    return { bytes, type: "image/png" };
  }
  requireMap(scope, mapId);
  return null;
}

/** The kept size a read names, for one of the set's PNGs; null when the
 * read names none or the picture keeps none. */
function wantedSize(set: ThumbnailSet | null, png: string, want: PictureWant): string | null {
  if (!set?.sizes || (png !== set.light && png !== set.dark)) return null;
  if (want.shape === undefined && want.width === undefined) return null;
  const shape = want.shape ?? "card";
  const widths = set.sizes[shape];
  const width = want.width === undefined ? widths[widths.length - 1] : keptWidth(widths, want.width);
  return sizedPictureFile(png, shape, width);
}

/**
 * Which of these maps the reader would be served a card image of now, so
 * a card asks for an image only when there is one, each with the basemap
 * that image was drawn on (null when none was recorded). One read of the
 * directory, then each map's published set and single image as
 * readThumbnail would try them, judged by what their evidence records
 * rather than by reading the images: an image whose evidence names other
 * bytes (a write that failed halfway) may be counted and then answer the
 * placeholder, as before. The two images of a set stand on the same
 * basemap's credit, so either names it.
 */
export async function servedThumbnails(scope: AccountScope, mapIds: readonly string[]): Promise<Map<string, DrawnBasemap | null>> {
  let names: Set<string>;
  try {
    names = new Set(await readdir(thumbnailsDir()));
  } catch {
    return new Map();
  }
  const served = await Promise.all(mapIds.map(async (mapId): Promise<[string, DrawnBasemap | null] | null> => {
    const set = names.has(path.basename(thumbnailManifestPath(mapId))) ? await readSet(mapId) : null;
    const files = [set?.light, set?.dark, path.basename(thumbnailPath(mapId))]
      .filter((name): name is string => name !== undefined && names.has(name));
    for (const name of files) {
      const evidence = await recordedEvidence(name);
      if (servableTo(scope, mapId, evidence.inputs)) return [mapId, evidence.basemap];
    }
    return null;
  }));
  return new Map(served.filter((entry): entry is [string, DrawnBasemap | null] => entry !== null));
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
 * the evidence of what it drew and was drawn on: the copy keeps the original's SQL and home.
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
    const singleEvidence = single ? await imageEvidence(path.basename(thumbnailPath(from)), single) : null;
    if (single && singleEvidence && servableTo(scope, from, singleEvidence.inputs)) {
      await writeImageEvidence(path.basename(thumbnailPath(to)), single, singleEvidence);
      await writeAtomically(thumbnailPath(to), single, authorize);
    }
    const set = await readSet(from);
    authorize();
    if (!set) return;
    const copied: ThumbnailSet = {
      light: set.light.replace(from, to),
      dark: set.dark.replace(from, to),
      ...(set.sizes ? { sizes: set.sizes } : {}),
    };
    const light = await readFile(inDir(set.light));
    authorize();
    const dark = await readFile(inDir(set.dark));
    const lightEvidence = await imageEvidence(set.light, light);
    const darkEvidence = await imageEvidence(set.dark, dark);
    if (!servableTo(scope, from, lightEvidence.inputs) || !servableTo(scope, from, darkEvidence.inputs)) return;
    // The kept sizes travel with their PNGs; a set missing one is copied
    // as the older picture it then is, without sizes.
    const sized: [string, Buffer][] = [];
    // One appearance names one file twice: its sizes are copied once.
    const pairs = set.dark === set.light ? [[set.light, copied.light]] as const : [[set.light, copied.light], [set.dark, copied.dark]] as const;
    for (const [source, target] of pairs) {
      if (!set.sizes) continue;
      for (const shape of PICTURE_SHAPE_NAMES) {
        for (const width of set.sizes[shape]) {
          try { sized.push([sizedPictureFile(target, shape, width), await readFile(inDir(sizedPictureFile(source, shape, width)))]); }
          catch { delete copied.sizes; }
        }
      }
    }
    authorize();
    await writeImageEvidence(copied.light, light, lightEvidence);
    await writeImageEvidence(copied.dark, dark, darkEvidence);
    if (copied.sizes) for (const [name, bytes] of sized) await writeAtomically(inDir(name), bytes, authorize);
    await writeAtomically(inDir(copied.light), light, authorize);
    await writeAtomically(inDir(copied.dark), dark, authorize);
    await writeAtomically(thumbnailManifestPath(to), JSON.stringify(copied), authorize);
  }));
}

export function thumbnailMutationIds(): string[] { return [...turns.keys()]; }
export function thumbnailTurnForTests(mapId: string): Promise<unknown> | undefined { return turns.get(mapId); }

/** Server candidates use fresh names for single images too, so switching
 * between one and two appearances is one atomic publication. */
export function savePictureSet(scope: AccountScope, mapId: string, images: { light: Uint8Array | PictureImages; dark?: Uint8Array | PictureImages },
  inputs: ArtifactInputs, basemaps: { light: DrawnBasemap; dark?: DrawnBasemap }, generation: number,
  check: () => void, published: () => void): Promise<void> {
  requireOwnMap(scope, mapId);
  const themes = images.dark ? THUMBNAIL_THEMES : ["light"] as const;
  const pictures = Object.fromEntries(themes.map((theme) => {
    const image = images[theme]!;
    return [theme, image instanceof Uint8Array ? { png: image, sized: [] } : image];
  })) as Partial<Record<ThumbnailTheme, PictureImages>>;
  // Refused before any work is admitted, so a refusal holds no lease.
  const sizes = listedSizes(themes.map((theme) => pictures[theme]!));
  const lease = admitResourceWork(scope, [{ table: "maps", id: mapId }]);
  const authorize = () => { requireOwnMap(scope, mapId); lease.assertCommit(); check(); };
  return inDeletionWork(lease, () => inThumbnailTurn(mapId, async () => {
    bindDeletionDatasets(inputs.datasets.map(input => input.id));
    authorize();
    const cycle = randomBytes(12).toString("hex");
    const light = thumbnailSetFile(mapId, cycle, "light");
    const dark = images.dark ? thumbnailSetFile(mapId, cycle, "dark") : light;
    const next: ThumbnailSet = { light, dark, ...(sizes ? { sizes } : {}) };
    try {
      for (const theme of themes) {
        // The kept sizes land first, so the PNG whose evidence serves
        // them, and then the switch, name only files already whole.
        for (const size of sizes ? pictures[theme]!.sized : []) {
          await writeAtomically(inDir(sizedPictureFile(next[theme], size.shape, size.width)), size.bytes, authorize);
        }
        await writeImageCandidate(next[theme], inDir(next[theme]), pictures[theme]!.png, { inputs, basemap: basemaps[theme]!, generation }, authorize);
      }
      await writeAtomically(thumbnailManifestPath(mapId), JSON.stringify(next), authorize, published);
    } catch (error) {
      // Never remove names already made authoritative by the switch.
      const current = await readSet(mapId);
      if (current?.light !== light) await Promise.all(setFiles(next).map(removeImage));
      throw error;
    }
    await removeImage(path.basename(thumbnailPath(mapId)));
    await retireUnreferenced(mapId, next);
  })).finally(() => lease.release());
}

/** The sizes a set lists: those every appearance kept, the same in each,
 * covering both shapes; none when any appearance kept none. A set whose
 * appearances disagree is refused rather than listed in part. */
function listedSizes(pictures: PictureImages[]): Record<PictureShape, number[]> | undefined {
  if (pictures.some((picture) => picture.sized.length === 0)) return undefined;
  const of = (picture: PictureImages) => Object.fromEntries(PICTURE_SHAPE_NAMES.map((shape) => [
    shape, picture.sized.filter((size) => size.shape === shape).map((size) => size.width).sort((a, b) => a - b),
  ])) as Record<PictureShape, number[]>;
  const sizes = of(pictures[0]);
  if (PICTURE_SHAPE_NAMES.some((shape) => sizes[shape].length === 0) ||
    pictures.some((picture) => JSON.stringify(of(picture)) !== JSON.stringify(sizes))) throw new Error("The picture's kept sizes are incomplete.");
  return sizes;
}

/** Whether the map's published picture lists kept sizes: made by this
 * version of the picture service. */
export async function publishedPictureSized(mapId: string): Promise<boolean> {
  return queueTurn(mapId, async () => !!(await readSet(mapId))?.sizes);
}

/** The generation is trusted only when every named image exists and its
 * byte-bound evidence agrees. Old files deliberately answer no generation. */
export async function publishedPictureGeneration(mapId: string): Promise<number | null> {
  return queueTurn(mapId, async () => {
    const set = await readSet(mapId);
    const names = set ? [...new Set([set.light, set.dark])] : [path.basename(thumbnailPath(mapId))];
    let generation: number | undefined;
    for (const name of names) {
      try {
        const found = (await imageEvidence(name, await readFile(inDir(name)))).generation;
        if (found === undefined || (generation !== undefined && found !== generation)) return null;
        generation = found;
      } catch { return null; }
    }
    return generation ?? null;
  });
}

/** Evidence of the currently named bytes, for freshness checks at a look. */
export async function publishedPictureInputs(mapId: string): Promise<ArtifactInputs | null> {
  return queueTurn(mapId, async () => {
    const set = await readSet(mapId);
    const name = set?.light ?? path.basename(thumbnailPath(mapId));
    try { return (await imageEvidence(name, await readFile(inDir(name)))).inputs; }
    catch { return null; }
  });
}
