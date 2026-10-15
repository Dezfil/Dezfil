import { observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
import { createHash, randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountScope } from "@/lib/auth/scope";
import type { AttributionLine } from "@/lib/basemap";
import { effectiveBasemap } from "@/lib/basemap-effective";
import { pictureBasemaps } from "@/lib/basemap-offer";
import { dataDir } from "@/lib/config";
import { getMap } from "@/lib/metadata/map-queries";
import { listLayers } from "@/lib/metadata/maps";
import type { DrawnBasemap } from "@/lib/picture-credit";
import { mapSqlRevision } from "@/lib/map-sql-revision";
import { boundedEvaluation } from "@/lib/query/bounded";
import { mapEvaluation } from "@/lib/query/context";
import { DatasetUnavailable } from "@/lib/query/engine-message";
import { collectInputs, parseInputs, type ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { namedSql } from "@/lib/query/named-sql";

/**
 * What a map's card image drew. The builder captures the image in the
 * browser and sends the map's SQL revision as it stood when the capture
 * started; the server stamps the image with the identities that revision's
 * SQL binds in the map's home within the uploader's reach, or marks it
 * unattributed when it cannot: no revision came with it, the map's layers
 * moved away from that revision before the stamp was made, or one of its
 * references no longer binds, so the image may show what the stamp cannot
 * name. An unattributed image is its map owner's alone.
 *
 * Each image's evidence names the image's own bytes by digest and lives
 * under its own directory of the data volume, so the thumbnail directory
 * holds images and manifests alone. Evidence of other bytes (an image
 * replaced by a write that failed halfway, or written before images
 * recorded their inputs) leaves the image unattributed.
 *
 * The evidence also records the basemap the image was drawn on, as the
 * map's effective basemap stood when the image was saved, with the credit
 * it claimed, so the image is credited by what it drew. An image saved
 * before images recorded it has none, and is credited by its map's
 * basemap now (picture-credit.ts). It goes wherever the evidence goes:
 * into a duplicate, and out with the image.
 */

/** What one image's evidence records: the inputs it drew, or null when it
 * is unattributed, and the basemap it was drawn on, or null when none was
 * recorded. */
export interface ImageEvidence {
  inputs: ArtifactInputs | null;
  basemap: DrawnBasemap | null;
}

const NO_EVIDENCE: ImageEvidence = { inputs: null, basemap: null };

function evidenceDir(): string {
  return path.join(dataDir(), "artifact-inputs", "thumbnails");
}

/** One image's evidence, by the image's file name. */
function evidencePath(image: string): string {
  return path.join(evidenceDir(), `${image}.json`);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Written whole and renamed into place, before the image it describes. */
export async function writeImageEvidence(image: string, bytes: Uint8Array, evidence: ImageEvidence, authorize: () => void = () => {}): Promise<void> {
  await mkdir(evidenceDir(), { recursive: true });
  const target = evidencePath(image);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ sha256: digest(bytes), inputs: evidence.inputs, basemap: evidence.basemap }));
    authorize();
    renameSync(temp, target);
  } catch (error) {
    await observeDeletionCleanup(() => rm(temp, { force: true }));
    throw error;
  }
}

/** An image's evidence as written, or null when there is none or it does
 * not read. */
async function readEvidence(image: string): Promise<{ sha256?: unknown; inputs?: unknown; basemap?: unknown } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(evidencePath(image), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** A recorded basemap as written, or null for anything else. */
function parseBasemap(value: unknown): DrawnBasemap | null {
  if (!value || typeof value !== "object") return null;
  const { url, kind, custom, attribution } = value as Record<string, unknown>;
  if (typeof url !== "string" || (kind !== "vector" && kind !== "imagery") || typeof custom !== "boolean" || !Array.isArray(attribution)) return null;
  const lines: AttributionLine[] = [];
  for (const line of attribution) {
    if (!line || typeof line !== "object") return null;
    const { label, href } = line as Record<string, unknown>;
    if (typeof label !== "string" || (href !== undefined && typeof href !== "string")) return null;
    lines.push(href === undefined ? { label } : { label, href });
  }
  return { url, kind, custom, attribution: lines };
}

/** What these bytes of this image drew and were drawn on; nothing for
 * evidence of other bytes. */
export async function imageEvidence(image: string, bytes: Uint8Array): Promise<ImageEvidence> {
  const parsed = await readEvidence(image);
  if (!parsed || parsed.sha256 !== digest(bytes)) return NO_EVIDENCE;
  return { inputs: parseInputs(parsed.inputs), basemap: parseBasemap(parsed.basemap) };
}

/** The inputs these bytes of this image drew, or null when the image is
 * unattributed. */
export async function imageInputs(image: string, bytes: Uint8Array): Promise<ArtifactInputs | null> {
  return (await imageEvidence(image, bytes)).inputs;
}

/** What this image's evidence records, read without the image: what a
 * listing judges and credits the image by. Serving reads the bytes and
 * holds the evidence to them (imageInputs), so evidence of other bytes
 * still leaves the image unattributed where it is served. */
export async function recordedEvidence(image: string): Promise<ImageEvidence> {
  const parsed = await readEvidence(image);
  return parsed ? { inputs: parseInputs(parsed.inputs), basemap: parseBasemap(parsed.basemap) } : NO_EVIDENCE;
}

export async function removeImageEvidence(image: string): Promise<void> {
  await observeDeletionCleanup(() => rm(evidencePath(image), { force: true }));
}

/** The images of one map that have evidence, by image file name. */
export async function evidencedImages(mapId: string): Promise<string[]> {
  try {
    return (await readdir(evidenceDir()))
      .filter((name) => name.startsWith(`${mapId}.`) && name.endsWith(".png.json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/** The basemap an image of the map saved now was drawn on: the map's
 * effective basemap at this moment as the builder draws it, in the
 * image's theme (a single image's, the light), with the credit it claims.
 * Null for a map that is gone. */
export function captureBasemap(mapId: string, theme: "light" | "dark" | null): DrawnBasemap | null {
  const map = getMap(mapId);
  if (!map) return null;
  const instance = pictureBasemaps();
  const { url, kind, custom, attribution } = effectiveBasemap({
    key: map.basemap,
    custom: map.customBasemap,
    theme: theme ?? "light",
    overrideUrl: instance.overrideUrl,
    defaultUrl: instance.defaultUrl,
    basemaps: instance.basemaps,
    overrideAttribution: instance.overrideAttribution,
  });
  return { url, kind, custom, attribution };
}

/** The map's SQL revision as its layers stand now. */
export function currentMapRevision(mapId: string): string {
  return mapSqlRevision(listLayers(mapId));
}

/**
 * The evidence a capture earns, or null when it stays unattributed. The
 * identities are bound by compiling each layer's SQL in the map's home
 * within the uploader's reach, the same binding a render records; nothing is
 * read from any dataset. A layer whose SQL does not compile drew nothing for
 * this revision; a reference that names a dataset the uploader cannot reach
 * makes the capture unattributable.
 */
export async function captureInputs(scope: AccountScope, mapId: string, revision: string | null): Promise<ArtifactInputs | null> {
  if (revision === null || currentMapRevision(mapId) !== revision) return null;
  const layers = listLayers(mapId);
  let unattributable = false;
  try {
    const { inputs } = await collectInputs(() => boundedEvaluation(async (conn) => {
      for (const layer of layers) {
        try {
          await namedSql(conn, layer.sql);
        } catch (error) {
          if (error instanceof DatasetUnavailable) unattributable = true;
        }
      }
    }, { scope: mapEvaluation(scope, mapId) }));
    if (unattributable || currentMapRevision(mapId) !== revision) return null;
    return inputs;
  } catch {
    return null;
  }
}
