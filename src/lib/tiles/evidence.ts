import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { dataDir } from "@/lib/config";
import type { TileRecord } from "@/lib/metadata/tiles";
import { tileArchivePath } from "./paths";
import { parseInputs, type ArtifactInputs } from "@/lib/query/evaluation-inputs";

/**
 * What a layer's tile archive drew. A build records the dataset identities
 * its export evaluation bound, with the artifact each was read from, and the
 * evidence belongs to exactly one archive: it names the fingerprint and the
 * build time of the record that makes that archive authoritative. Evidence
 * that names another record, or no evidence at all (an archive built before
 * archives recorded their inputs), leaves the archive unattributed.
 *
 * The evidence lives under its own directory of the data volume, so the tile
 * directory keeps holding archives alone.
 */
export interface TileEvidence {
  fingerprint: string;
  builtAt: string;
  inputs: ArtifactInputs;
}

function evidenceDir(): string {
  return path.join(dataDir(), "artifact-inputs", "tiles");
}

/** Layer ids are UUIDs: safe as file names by construction. */
export function tileEvidencePath(layerId: string): string {
  return path.join(evidenceDir(), `${layerId}.json`);
}

/** Written whole and renamed into place, before the archive it describes. */
export function writeTileEvidence(layerId: string, evidence: TileEvidence): void {
  mkdirSync(evidenceDir(), { recursive: true });
  const target = tileEvidencePath(layerId);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(evidence));
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function removeTileEvidence(layerId: string): void {
  rmSync(tileEvidencePath(layerId), { force: true });
}

function readEvidence(file: string, strict = false): TileEvidence | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TileEvidence>;
    const inputs = parseInputs(parsed.inputs);
    if (!inputs || typeof parsed.fingerprint !== "string" || typeof parsed.builtAt !== "string") return null;
    return { fingerprint: parsed.fingerprint, builtAt: parsed.builtAt, inputs };
  } catch (error) {
    if (strict && !(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/**
 * The inputs of the archive a ready record makes authoritative, or null when
 * there are none to go by: no ready record, no evidence, or evidence of
 * another build.
 */
export function tileArchiveInputs(layerId: string, record: TileRecord | null): ArtifactInputs | null {
  const attribution = tileArchiveAttribution(layerId, record);
  return typeof attribution === "object" ? attribution.inputs : null;
}

/**
 * Whom the layer's archive can be attributed to, for serving it:
 *  - the inputs its build recorded, when the evidence names the ready record;
 *  - "unattributed", when there is no evidence at all: an archive built
 *    before archives recorded their inputs, its map owner's alone;
 *  - "unbound", when the evidence names another build: the archive on disk
 *    may be one being swapped in, so it is nobody's until a record names it.
 * Every build writes its evidence before its archive, so evidence that names
 * no current record never describes an archive older than itself.
 */
export type ArchiveAttribution = { inputs: ArtifactInputs } | "unattributed" | "unbound";

export function tileArchiveAttribution(layerId: string, record: TileRecord | null): ArchiveAttribution {
  const file = tileEvidencePath(layerId);
  if (!existsSync(file)) return "unattributed";
  const evidence = readEvidence(file);
  if (!evidence || !record || record.state !== "ready" || evidence.fingerprint !== record.fingerprint
    || evidence.builtAt !== record.builtAt) return "unbound";
  return { inputs: evidence.inputs };
}

/** Whether the layer's archive on disk was built before archives recorded
 * their inputs: an archive with no evidence beside it. Every build since
 * writes its evidence before its archive. */
export function archiveWithoutEvidence(layerId: string): boolean {
  return existsSync(tileArchivePath(layerId)) && !existsSync(tileEvidencePath(layerId));
}

/** Every layer whose recorded evidence names this dataset. */
export function layersWithEvidenceOf(datasetId: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(evidenceDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const layers: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const evidence = readEvidence(path.join(evidenceDir(), entry), true);
    if (evidence?.inputs.datasets.some((input) => input.id === datasetId)) layers.push(entry.slice(0, -".json".length));
  }
  return layers;
}

/** Every layer id with evidence on the volume, for the boot sweep. */
export function evidencedLayerIds(): string[] {
  try {
    return readdirSync(evidenceDir()).filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/**
 * The inputs of builds still running, by attempt: what the render that asked
 * for them bound, and once their export has run, what the export bound. A
 * dataset's refresh or deletion finds these too, so it can fence a build
 * that is reading it.
 */
const runningKey = Symbol.for("dezfil.tile-inputs");
const runningHost = globalThis as typeof globalThis & { [runningKey]?: Map<string, { layerId: string; inputs: ArtifactInputs | null }> };
const running = runningHost[runningKey] ??= new Map<string, { layerId: string; inputs: ArtifactInputs | null }>();

export function trackBuildInputs(attemptId: string, layerId: string, inputs: ArtifactInputs | null): void {
  running.set(attemptId, { layerId, inputs });
}

export function untrackBuildInputs(attemptId: string): void {
  running.delete(attemptId);
}

export function runningLayersOf(datasetId: string): string[] {
  return [...running.values()]
    .filter((attempt) => attempt.inputs?.datasets.some((input) => input.id === datasetId))
    .map((attempt) => attempt.layerId);
}

/** Tests reset shared state. */
export function resetBuildInputs(): void {
  running.clear();
}

export function runningTileInputsForTests(): string[] { return [...running.values()].map(r => r.layerId); }
