import { observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
import { createHash, randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountScope } from "@/lib/auth/scope";
import { dataDir } from "@/lib/config";
import { listLayers } from "@/lib/metadata/maps";
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
 */

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
export async function writeImageEvidence(image: string, bytes: Uint8Array, inputs: ArtifactInputs | null, authorize: () => void = () => {}): Promise<void> {
  await mkdir(evidenceDir(), { recursive: true });
  const target = evidencePath(image);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ sha256: digest(bytes), inputs }));
    authorize();
    renameSync(temp, target);
  } catch (error) {
    await observeDeletionCleanup(() => rm(temp, { force: true }));
    throw error;
  }
}

/** The inputs these bytes of this image drew, or null when the image is
 * unattributed. */
export async function imageInputs(image: string, bytes: Uint8Array): Promise<ArtifactInputs | null> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath(image), "utf8")) as { sha256?: unknown; inputs?: unknown };
    if (parsed.sha256 !== digest(bytes)) return null;
    return parseInputs(parsed.inputs);
  } catch {
    return null;
  }
}

/** The inputs this image's evidence records, read without the image: what
 * a listing judges the image by. Serving reads the bytes and holds the
 * evidence to them (imageInputs), so evidence of other bytes still
 * leaves the image unattributed where it is served. */
export async function recordedInputs(image: string): Promise<ArtifactInputs | null> {
  try {
    return parseInputs((JSON.parse(await readFile(evidencePath(image), "utf8")) as { inputs?: unknown }).inputs);
  } catch {
    return null;
  }
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
