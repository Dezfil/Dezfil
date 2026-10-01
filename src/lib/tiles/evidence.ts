import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { dataDir } from "@/lib/config";
import type { TileRecord } from "@/lib/metadata/tiles";
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

function readEvidence(file: string): TileEvidence | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TileEvidence>;
    const inputs = parseInputs(parsed.inputs);
    if (!inputs || typeof parsed.fingerprint !== "string" || typeof parsed.builtAt !== "string") return null;
    return { fingerprint: parsed.fingerprint, builtAt: parsed.builtAt, inputs };
  } catch {
    return null;
  }
}

/**
 * The inputs of the archive a ready record makes authoritative, or null when
 * the archive is unattributed: no ready record, no evidence, or evidence of
 * another build.
 */
export function tileArchiveInputs(layerId: string, record: TileRecord | null): ArtifactInputs | null {
  if (!record || record.state !== "ready" || !record.builtAt) return null;
  const evidence = readEvidence(tileEvidencePath(layerId));
  if (!evidence || evidence.fingerprint !== record.fingerprint || evidence.builtAt !== record.builtAt) return null;
  return evidence.inputs;
}

/** Every layer whose recorded evidence names this dataset. */
export function layersWithEvidenceOf(datasetId: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(evidenceDir());
  } catch {
    return [];
  }
  const layers: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const evidence = readEvidence(path.join(evidenceDir(), entry));
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
const running = new Map<string, { layerId: string; inputs: ArtifactInputs | null }>();

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
