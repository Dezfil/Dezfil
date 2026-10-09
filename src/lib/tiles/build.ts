import { admitAccountWork, type AccountWorkLease } from "@/lib/auth/account-deletion-admission";
import { bindDeletionDatasets, inDetachedDeletionWork, observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
import { closeTileArchives } from "./serve";
import { metadataDb } from "@/lib/metadata/db";
import { archiveServable, tileQueryScope, tileReachKey, requireTileAccess, tileAccessAvailable, type TileAccess } from "./access";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { limits } from "@/lib/limits";
import { filteredSql } from "@/lib/query/compile";
import type { LayerFilter } from "@/lib/viz";
import {
  getTileRecord,
  upsertTileRecord,
  deleteTileRecord,
} from "@/lib/metadata/tiles";
import { currentInputs } from "@/lib/table-deps";
import { collectInputs, inputsKey, NO_INPUTS, type ArtifactInputs } from "@/lib/query/evaluation-inputs";
import {
  removeTileEvidence,
  evidencedLayerIds,
  resetBuildInputs,
  tileArchiveAttribution,
  tileArchiveInputs,
  trackBuildInputs,
  untrackBuildInputs,
  writeTileEvidence,
} from "./evidence";
import { exportGeoJsonSeq } from "./export";
import { runTiler } from "./tiler";
import {
  ensureTileDirs,
  tileArchivePath,
  tileScratchDir,
  tilesDir,
} from "./paths";

/**
 * Tile build orchestration. A build streams the layer's effective result to
 * the scratch directory, runs tippecanoe over it, and atomically renames the
 * finished archive into place — the previous archive keeps serving until
 * that instant (decision 5). Builds are background work: one at a time
 * process-wide so a big build cannot starve queries, one per layer and
 * requesting reach with latest-wins replacement so a burst of edits
 * converges on the newest effective query. The layer's record is its served
 * archive and that archive's status: only a build that commits replaces
 * it, so a caller whose build is refused or fails, its failure kept against
 * its own attempt, never displaces an archive someone else is served. The
 * fingerprint covers the effective query plus the identities the evaluation
 * recorded with their artifacts — styling can never look like a data
 * change, and a data change can never fail to look like one. Each archive
 * keeps the evidence of what its export drew.
 */

export interface TileBuildInput {
  layerId: string;
  sql: string;
  filters: LayerFilter[];
  geometryColumn: string;
  /** Non-geometry columns the archive carries — the effective published
   * field set, resolved against the result. One shared archive serves
   * builder and published routes, built projected. */
  columns: string[];
  /** Canonical projection signature — folded into the
   * fingerprint so a config edit that changes the effective set rebuilds,
   * and one a published reader recomputes to authorize serving. */
  projection: string;
  /** What the evaluation asking for tiles bound: the identities this query
   * reads for this caller. Absent, the current archive's recorded inputs
   * stand in, so freshness is still decided by identity. */
  inputs?: ArtifactInputs;
}

/** What a render response reports about a layer's tiles. */
export interface TileStatus {
  state: "building" | "ready" | "failed";
  /** Present when ready. */
  featureCount?: number;
  builtAt?: string;
  /** Present when failed. */
  error?: string;
}

/** The fingerprint covers the effective query AND the dataset identities
 * an evaluation of it bound, each with its artifact: a refresh mints a new
 * artifact file, so pre-refresh tiles can never read as fresh — even
 * when the prompt invalidation was lost to a transient failure, the next
 * render re-decides freshness from the data itself. It also covers the
 * projection signature, so a config edit that changes the effective
 * published field set can never fail to look like a change. Pure styling
 * (colors, bounds, opacity) still never looks like one: the signature
 * carries attribute names, not paint. */
export function tileFingerprint(
  sql: string,
  filters: LayerFilter[],
  projection: string,
  inputs: ArtifactInputs,
): string {
  return createHash("sha256")
    .update(filteredSql(sql, filters))
    .update("\u0000")
    .update(inputsKey(inputs))
    .update("\u0000")
    .update(projection)
    .digest("hex")
    .slice(0, 16);
}

/** The identities a request's freshness is decided by: what its own
 * evaluation bound, else what the current archive recorded, as each dataset
 * stands now. */
function requestInputs(input: TileBuildInput, record: ReturnType<typeof getTileRecord>): ArtifactInputs {
  if (input.inputs) return input.inputs;
  const recorded = tileArchiveInputs(input.layerId, record);
  return recorded ? currentInputs(recorded) : NO_INPUTS;
}

// ---- the queue ----

interface BuildAttempt {
  id: string;
  /** The layer and the reach that asked: attempts are kept apart by both. */
  key: string;
  input: TileBuildInput;
  access: TileAccess;
  fingerprint: string;
  generation: number;
  done: ReturnType<typeof Promise.withResolvers<void>>;
  deletionWork: AccountWorkLease;
}

/** A layer's attempt for one requesting reach. */
const attemptKey = (layerId: string, access: TileAccess) => `${layerId}\u0000${tileReachKey(access)}`;
const keyOfLayer = (key: string, layerId: string) => key.startsWith(`${layerId}\u0000`);

/** Each layer's scheduled or running build, per requesting reach. */
const activeKey = Symbol.for("dezfil.tile-active");
const activeHost = globalThis as typeof globalThis & { [activeKey]?: Map<string, BuildAttempt> };
const active = activeHost[activeKey] ??= new Map<string, BuildAttempt>();
/** A newer input that arrived while that reach's build was running. */
const pendingKey = Symbol.for("dezfil.tile-pending");
const pendingHost = globalThis as typeof globalThis & { [pendingKey]?: Map<string, { access: TileAccess; input: TileBuildInput }> };
const pending = pendingHost[pendingKey] ??= new Map<string, { access: TileAccess; input: TileBuildInput }>();
/** The last failure of each reach's attempt: its query and why. It sticks
 * for that query, for that reach alone, until the data under it changes,
 * the layer goes, or the process restarts. */
const failuresKey = Symbol.for("dezfil.tile-failures");
const failuresHost = globalThis as typeof globalThis & { [failuresKey]?: Map<string, { fingerprint: string; generation: number; error: string }> };
const failures = failuresHost[failuresKey] ??= new Map<string, { fingerprint: string; generation: number; error: string }>();
/** Deletion advances the generation, fencing every older attempt. */
const generationsKey = Symbol.for("dezfil.tile-generations");
const generationsHost = globalThis as typeof globalThis & { [generationsKey]?: Map<string, number> };
const generations = generationsHost[generationsKey] ??= new Map<string, number>();
/** Builds run one at a time process-wide. */
const chainKey = Symbol.for("dezfil.tile-chain");
const chainHost = globalThis as typeof globalThis & { [chainKey]?: { value: Promise<unknown> } };
const chain = chainHost[chainKey] ??= { value: Promise.resolve() };

/** Tests reset shared state. */
export function resetTileBuilds(): void {
  active.clear();
  pending.clear();
  failures.clear();
  generations.clear();
  resetBuildInputs();
  chain.value = Promise.resolve();
}

/** Forget every reach's queued input and failure for a layer. */
function forgetLayer(layerId: string): void {
  for (const map of [pending, failures]) {
    for (const key of [...map.keys()]) if (keyOfLayer(key, layerId)) map.delete(key);
  }
}

/** Resolve once no build is running or queued (tests, journeys). */
export async function tileBuildsSettled(): Promise<void> {
  while (active.size > 0 || pending.size > 0) {
    await chain.value.then(
      () => undefined,
      () => undefined,
    );
    // Let finally-handlers run so follow-on builds enter the chain.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The layer's tiler run, under the tile-build timeout, said as the
 * layer's own build message when it fails. */
async function runTippecanoe(input: string, output: string): Promise<void> {
  const run = await runTiler(input, output, limits.tileBuildTimeoutMs);
  if (run.ok) return;
  throw new Error(
    run.reason === "timed_out"
      ? `Tiling exceeded the ${Math.round(
          limits.tileBuildTimeoutMs / 1000,
        )}s tile-build timeout. Narrow the layer, or raise DEZFIL_TILE_BUILD_TIMEOUT_S.`
      : run.detail || "The tiler failed.",
  );
}

function generation(layerId: string): number {
  return generations.get(layerId) ?? 0;
}

function attemptCanCommit(attempt: BuildAttempt): boolean {
  try {
    attempt.deletionWork.assertCommit();
    return (
      active.get(attempt.key) === attempt &&
      generation(attempt.input.layerId) === attempt.generation &&
      tileAccessAvailable(attempt.access)
    );
  } catch {
    return false;
  }
}

async function runBuild(attempt: BuildAttempt): Promise<void> {
  const { input, fingerprint } = attempt;
  ensureTileDirs();
  const scratchBase = path.join(
    tileScratchDir(),
    `${input.layerId}.${attempt.id}`,
  );
  const exportFile = `${scratchBase}.geojsonl`;
  const archiveFile = `${scratchBase}.pmtiles`;
  let finalArchiveNeedsRemoval = false;
  try {
    // A queued attempt may have been deleted before its turn reached the
    // process-wide worker. It has nothing to do and must write no state.
    if (!attemptCanCommit(attempt)) return;
    // The export's own evaluation is the archive's evidence: the identities
    // it bound, with the artifacts it read, whatever the render saw before.
    const { value: featureCount, inputs } = await collectInputs(() => exportGeoJsonSeq(tileQueryScope(attempt.access),
      {
        sql: input.sql,
        filters: input.filters,
        geometryColumn: input.geometryColumn,
        columns: input.columns,
      },
      exportFile,
    ));
    bindDeletionDatasets(inputs.datasets.map(input => input.id));
    trackBuildInputs(attempt.id, input.layerId, inputs);
    if (!attemptCanCommit(attempt)) return;
    await runTippecanoe(exportFile, archiveFile);
    if (!attemptCanCommit(attempt)) return;
    // The record names the data the archive actually holds.
    const built = tileFingerprint(input.sql, input.filters, input.projection, inputs);
    const builtAt = new Date().toISOString();
    // Evidence first: until the record below names this build, the evidence
    // and the archive belong to no record and the archive is unattributed.
    writeTileEvidence(input.layerId, { fingerprint: built, builtAt, inputs });
    // Same filesystem: the swap is atomic, the old archive serves until now.
    await rename(archiveFile, tileArchivePath(input.layerId));
    finalArchiveNeedsRemoval = true;
    // Deletion can cross the asynchronous rename. Recheck on its far side
    // before making the archive authoritative in metadata.
    if (!attemptCanCommit(attempt)) {
      await observeDeletionCleanup(() => rm(tileArchivePath(input.layerId), { force: true }));
      removeTileEvidence(input.layerId);
      finalArchiveNeedsRemoval = false;
      return;
    }
    metadataDb().transaction(() => {
      requireTileAccess(attempt.access, input.layerId);
      upsertTileRecord({
        layerId: input.layerId,
        state: "ready",
        fingerprint: built,
        error: null,
        featureCount,
        builtAt,
      });
    })();
    finalArchiveNeedsRemoval = false;
  } catch (error) {
    if (finalArchiveNeedsRemoval) {
      await observeDeletionCleanup(() => rm(tileArchivePath(input.layerId), { force: true })).catch(
        () => undefined,
      );
    }
    // The failure is this attempt's alone: it never replaces the layer's
    // record, which still names whatever archive others are served.
    if (attemptCanCommit(attempt)) {
      failures.set(attempt.key, {
        fingerprint,
        generation: attempt.generation,
        error: error instanceof Error ? error.message : "The build failed.",
      });
      try {
        const record = getTileRecord(input.layerId);
        if (record?.state === "building" && record.fingerprint === fingerprint) deleteTileRecord(input.layerId);
      } catch {
        // A terminal metadata failure is contained here. A later render can
        // retry; the process-wide queue must remain usable.
      }
    }
  } finally {
    untrackBuildInputs(attempt.id);
    await Promise.allSettled([
      observeDeletionCleanup(() => rm(exportFile, { force: true })),
      observeDeletionCleanup(() => rm(archiveFile, { force: true })),
    ]);
    if (active.get(attempt.key) === attempt) {
      // A withdrawn capability leaves no stuck build status. Retrying after
      // reactivation or through a current publication starts a fresh attempt.
      try {
        if (!tileAccessAvailable(attempt.access)) {
          const record = getTileRecord(input.layerId);
          if (record?.state === "building" && record.fingerprint === fingerprint) deleteTileRecord(input.layerId);
        }
      } catch (error) {
        console.warn(`[tiles] abandoned build ${attempt.id} could not clear its status:`, error);
      } finally { active.delete(attempt.key); }
    }
    const next = pending.get(attempt.key);
    if (next) {
      pending.delete(attempt.key);
      try {
        if (tileAccessAvailable(next.access)) start(next.access, next.input);
      } catch (error) {
        console.warn(`[tiles] queued build for ${input.layerId} could not start:`, error);
      }
    }
  }
}

function start(access: TileAccess, input: TileBuildInput): void {
  requireTileAccess(access, input.layerId);
  const fingerprint = tileFingerprint(input.sql, input.filters, input.projection, requestInputs(input, getTileRecord(input.layerId)));
  const attempt: BuildAttempt = {
    access,
    id: randomUUID(),
    key: attemptKey(input.layerId, access),
    input,
    fingerprint,
    generation: generation(input.layerId),
    done: Promise.withResolvers<void>(),
    deletionWork: admitAccountWork([access.ownerId, ...("scope" in access.credential ? [access.credential.scope.accountId] : [])]),
  };
  try {
  inDetachedDeletionWork(attempt.deletionWork, () => bindDeletionDatasets(input.inputs?.datasets.map(input => input.id) ?? []));
  failures.delete(attempt.key);
  // The record shows a build only while it names no archive: a ready one
  // keeps serving whoever may be served it until a build replaces it.
  metadataDb().transaction(() => {
    requireTileAccess(access, input.layerId);
    if (getTileRecord(input.layerId)?.state === "ready") return;
    upsertTileRecord({
      layerId: input.layerId,
      state: "building",
      fingerprint,
      error: null,
      featureCount: null,
      builtAt: null,
    });
  })();
  active.set(attempt.key, attempt);
  trackBuildInputs(attempt.id, input.layerId, input.inputs ?? null);
  } catch (error) { attempt.deletionWork.release(); throw error; }
  const work = () => inDetachedDeletionWork(attempt.deletionWork, () => runBuild(attempt)).finally(() => { attempt.deletionWork.release(); attempt.done.resolve(); });
  // Contain every terminal failure so one bad target cannot poison the
  // global queue or become an unhandled rejection.
  chain.value = chain.value.then(work, work).catch(() => undefined);
}

/**
 * Report the layer's tile status for its current effective query, as this
 * caller may be served it, starting or queueing a build in the caller's
 * reach when the archive is missing, stale or beyond that reach. A failed
 * build stays failed for that same effective query and reach (no retry
 * storm on render polling); it re-runs when the query or the data under it
 * changes, or the process restarts.
 */
export function ensureTiles(access: TileAccess, input: TileBuildInput): TileStatus {
  requireTileAccess(access, input.layerId);
  const record = getTileRecord(input.layerId);
  const fingerprint = tileFingerprint(input.sql, input.filters, input.projection, requestInputs(input, record));
  const key = attemptKey(input.layerId, access);

  // The served archive, when it is this query's and the caller may be
  // served what it drew, whatever anyone else's build is doing.
  if (
    record?.state === "ready" &&
    record.fingerprint === fingerprint &&
    existsSync(tileArchivePath(input.layerId)) &&
    archiveServable(access, tileArchiveAttribution(input.layerId, record))
  ) {
    return {
      state: "ready",
      featureCount: record.featureCount ?? undefined,
      builtAt: record.builtAt ?? undefined,
    };
  }

  const running = active.get(key);
  if (running !== undefined) {
    if (running.generation !== generation(input.layerId)) {
      // The id was deleted and may have been restored by undo. Its fresh
      // lifecycle waits behind the fenced attempt, even when SQL is identical.
      pending.set(key, { access, input });
    } else if (running.fingerprint !== fingerprint || !tileAccessAvailable(running.access)) {
      pending.set(key, { access, input }); // latest wins
    }
    return { state: "building" };
  }

  const failure = failures.get(key);
  if (failure && failure.fingerprint === fingerprint && failure.generation === generation(input.layerId)) {
    return { state: "failed", error: failure.error };
  }

  // Another reach's live build of this very query draws the same identities
  // with the same artifacts: its archive will be this caller's too.
  for (const attempt of active.values()) {
    if (attempt.input.layerId === input.layerId && attempt.fingerprint === fingerprint &&
      attempt.generation === generation(input.layerId) && tileAccessAvailable(attempt.access)) {
      return { state: "building" };
    }
  }

  start(access, input);
  return { state: "building" };
}

/** Invalidate a layer's tile lifecycle because the data under it changed
 * deleting the record alone leaves a build already running free to
 * commit an archive of the old data under an unchanged fingerprint.
 * Fence first, so an in-flight attempt cannot commit; the served
 * archive is deliberately kept — it serves until a fresh build renames
 * over it. Returns whether a record was dropped. */
export function invalidateTileBuild(layerId: string): boolean {
  generations.set(layerId, generation(layerId) + 1);
  for (const key of [...failures.keys()]) if (keyOfLayer(key, layerId)) failures.delete(key);
  const existed = getTileRecord(layerId) !== null;
  deleteTileRecord(layerId);
  return existed;
}

/** Remove a layer's tile artifacts — archive, record, scratch leftovers.
 * Called wherever the layer (or its map) is deleted. */
export async function removeTileArtifacts(layerId: string): Promise<void> {
  // Fence first: work crossing this point may finish computing, but cannot
  // rename output or write tile state for the deleted lifecycle.
  generations.set(layerId, generation(layerId) + 1);
  forgetLayer(layerId);
  deleteTileRecord(layerId);
  removeTileEvidence(layerId);
  await rm(tileArchivePath(layerId), { force: true });
}

/** A crashed process leaves exports behind; boot sweeps the scratch clean.
 * Safe by construction: running builds re-create what they need. */
export async function cleanTileScratch(): Promise<void> {
  await rm(tileScratchDir(), { recursive: true, force: true });
  ensureTileDirs();
}

/**
 * Boot sweep for served archives: an archive whose layer has no tile
 * record is never authoritative — a failed unlink after a delete, or a
 * build interrupted by a crash — yet it remains directly servable at its
 * old URL. At boot no build is running, so removing record-less archives
 * is safe; a ready record's archive is exactly what must survive.
 * Removals are logged.
 */
export async function sweepTileArchives(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(tilesDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".pmtiles")) continue;
    const layerId = entry.slice(0, -".pmtiles".length);
    if (getTileRecord(layerId) !== null) continue;
    await rm(path.join(tilesDir(), entry), { force: true });
    removed += 1;
    console.warn(`boot sweep: removed recordless tile archive ${entry}`);
  }
  // Evidence without a record describes no archive anyone may be served.
  for (const layerId of evidencedLayerIds()) {
    if (getTileRecord(layerId) === null) removeTileEvidence(layerId);
  }
  return removed;
}

/** Account cleanup waits actual writers, then removes their scratch and all
 * retained lifecycle state. Authority is restricted to captured layer ids. */
export async function eraseTileArtifacts(layerIds: readonly string[]): Promise<void> {
  const waits = [...active.values()].filter(a => layerIds.includes(a.input.layerId)).map(a => a.done.promise);
  for (const id of layerIds) { generations.set(id, generation(id) + 1); forgetLayer(id); }
  await Promise.all(waits);
  await closeTileArchives(layerIds);
  for (const id of layerIds) {
    await removeTileArtifacts(id);
    let names: string[];
    try { names = await readdir(tileScratchDir()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
    for (const name of names.filter(n => n.startsWith(`${id}.`))) await rm(path.join(tileScratchDir(), name), { force: true });
    generations.delete(id); forgetLayer(id);
  }
}
export function tileBuildStateForTests() {
  return { active: [...active.values()].map(a => a.input.layerId), pending: [...pending.values()].map(a => a.input.layerId),
    failures: [...failures.keys()].map(k => k.split("\u0000")[0]), generations: [...generations.keys()] };
}
