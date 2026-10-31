import { admitStorageWrite } from "@/lib/system/storage-admission";
import { rethrowStorageFailure } from "@/lib/system/storage-errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { withTrustedMutation } from "@/lib/trusted-mutation";
import { sharedTrustedWork } from "@/lib/trusted-shared";
import { trustedQueueTurn } from "@/lib/trusted-queue";
import type { Database } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { ingestScratchDir } from "@/lib/ingest/scratch";
import { limits } from "@/lib/limits";
import { metadataDb } from "@/lib/metadata/db";
import { openRemote, transportCode } from "@/lib/net/remote-fetch";
import { addressOrigin } from "@/lib/settings/disclosure";
import { downloadedSize, fetchTarget, noCredentialHop, requireCatalogueAt, TEMPLATE_USER_AGENT, withoutCredentials, type ListedEntry } from "./catalogue";
import type { CatalogueInEffect } from "./catalogue-address";
import { TEMPLATE_ARCHIVE_MAX_BYTES } from "./format";
import { installTemplateArchive } from "./install";
import type { InstalledOrigin } from "./installed";
import { preserveTemplateResourceRefusal, refuse, TemplateRefusal } from "./refusals";

/**
 * Downloading a listed version, once.
 *
 * A fetch first finds the version installed and answers at once. Else it
 * joins the download of that version already in flight or queued, or
 * queues one of its own. Downloads run one at a time on this instance,
 * and one at its turn does not ask again whether its version is installed:
 * the check at entry and the join have already made a second download of
 * one version impossible, since a caller arriving while one is queued or
 * under way joins it, and one arriving after it finished finds the version
 * installed. At its turn it does ask whether the catalogue is still in use
 * where the version was listed, so a download queued before an admin
 * turned the catalogue off or moved it sends nothing.
 *
 * The archive is read from the address the kept list names (through the
 * outbound engine, each redirect hop under the egress check, no credential
 * on any hop, within the link import's time bound) or from the catalogue's
 * folder, into a scratch folder of its own under the ingest scratch, which
 * the boot sweep clears. Its bytes are counted against the size the index
 * declares and the archive bound as they land and hashed as they land;
 * then the size and the checksum are compared with the index's, and only
 * then is the archive installed. A refusal at any step, coded, and any
 * failure leave nothing: the scratch folder goes whatever happened.
 */

export interface FetchedTemplate {
  id: string;
  version: number;
  /** The archive's size as transferred. */
  size: number;
  /** Whether this call's download installed it (or one it joined); false
   * when it was installed already. */
  downloaded: boolean;
}

/** A seam for tests over callers: told of each caller entering a
 * download (joining one, or queuing its own), and of each download at its
 * turn, before its first request, which waits for what it answers. */
export interface DownloadSeam {
  entered?(key: string): void;
  transfer?(key: string): void | Promise<void>;
}

interface Downloads {
  /** The download of each version, in flight or queued, by `<id>@<version>`. */
  byKey: Map<string, ReturnType<typeof sharedTrustedWork<FetchedTemplate>>>;
  /** The end of the queue: the next download starts after it settles. */
  tail: Promise<void>;
  seam: DownloadSeam;
}

const DOWNLOADS = Symbol.for("dezfil.template-downloads");
const host = globalThis as typeof globalThis & { [DOWNLOADS]?: Downloads };
const downloads: Downloads = host[DOWNLOADS] ??= { byKey: new Map(), tail: Promise.resolve(), seam: {} };

export function setDownloadSeamForTests(seam: DownloadSeam | null): void {
  downloads.seam = seam ?? {};
}

const keyOf = (id: string, version: number) => `${id}@${version}`;

function archiveOrigin(where: CatalogueInEffect): InstalledOrigin {
  if (where.kind === "folder") return { kind: "folder" };
  const origin = addressOrigin(where.address);
  if (!origin) throw new Error("A catalogue address this server reads has a scheme and host.");
  return { kind: "catalogue", origin };
}

/** The bytes of an archive as they land: counted against what the index
 * declares and the bound, and hashed. One pipeline carries them from the
 * body to the file, so a failure anywhere along it (the body's, the
 * count's refusal, or the file's own, a full disk's included, which comes
 * after the write was accepted) ends the transfer with that failure,
 * every stream closed, and nothing waits on a stream that has failed. */
async function land(body: Readable, file: string, declared: number): Promise<{ size: number; sha256: string }> {
  try { admitStorageWrite(declared); } catch (error) { body.destroy(); throw error; }
  const hash = createHash("sha256");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > declared || size > TEMPLATE_ARCHIVE_MAX_BYTES) {
        done(new TemplateRefusal("template_archive_too_large", `The archive is larger than the ${declared} bytes the catalogue's index declares.`));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try { await pipeline(body, count, createWriteStream(file, { flags: "wx" }), { signal: currentTrustedOperation()?.signal }); }
  catch (error) { rethrowStorageFailure(error); throw error; }
  return { size, sha256: hash.digest("hex") };
}

/** A download's own words for the outbound engine's failures: never the
 * address, which the catalogue setting discloses as scheme and host. */
function unreached(error: unknown, timedOut: ApiError): never {
  preserveTemplateResourceRefusal(error);
  if (error === timedOut) throw error;
  if (error instanceof ApiError && error.code === "remote_fetch_failed") {
    const code = transportCode(error);
    throw new ApiError("remote_fetch_failed",
      `The template's archive could not be read from the catalogue${code ? ` (${code})` : ""}.`, 502);
  }
  throw error;
}

/** Read the archive the entry names into `file`. */
async function transfer(entry: Pick<ListedEntry, "archive" | "size">, where: CatalogueInEffect, file: string): Promise<{ size: number; sha256: string }> {
  if (where.kind === "folder") {
    const { size } = await stat(entry.archive);
    if (size > entry.size || size > TEMPLATE_ARCHIVE_MAX_BYTES) {
      refuse("template_archive_too_large", `The archive is ${size} bytes; the catalogue's index declares ${entry.size}.`);
    }
    return land(createReadStream(entry.archive), file, entry.size);
  }
  const timedOut = new ApiError("remote_timeout", "The template's archive did not arrive within the link import's time bound.", 504);
  try {
    const response = await openRemote(withoutCredentials(new URL(entry.archive)).toString(), {
      signal: currentTrustedOperation()?.signal,
      timeoutMs: limits.remoteTimeoutMs,
      timeoutError: () => timedOut,
      onRedirect: noCredentialHop,
      headers: { "user-agent": TEMPLATE_USER_AGENT },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy();
      throw new ApiError("remote_fetch_failed", `The catalogue answered the template's archive with ${response.statusCode}.`, 502);
    }
    if (Number(response.headers["content-length"]) > entry.size) {
      response.body.destroy();
      refuse("template_archive_too_large", `The archive is larger than the ${entry.size} bytes the catalogue's index declares.`);
    }
    return await land(response.body, file, entry.size);
  } catch (error) {
    return unreached(error, timedOut);
  }
}

/** Transfer and verify release bytes before any archive member is read.
 * Shared by catalogue downloads and the command that prepares shipped templates. */
export async function transferTemplateArchive(
  entry: Pick<ListedEntry, "archive" | "size" | "sha256">,
  where: CatalogueInEffect,
  file: string,
): Promise<{ size: number; sha256: string }> {
  currentTrustedOperation()?.enterStage("archive transfer");
  const landed = await transfer(entry, where, file);
  currentTrustedOperation()?.assertCanCommit();
  if (landed.size !== entry.size) {
    refuse("template_checksum_mismatch", `The archive is ${landed.size} bytes; the catalogue's index declares ${entry.size}.`);
  }
  if (landed.sha256 !== entry.sha256) {
    refuse("template_checksum_mismatch", "The archive's SHA-256 differs from the one the catalogue's index declares.");
  }
  return landed;
}

/** One download at its turn: the catalogue still where it was listed, then
 * transfer, check, install; the scratch goes. */
async function download(scope: AccountScope, entry: ListedEntry, where: CatalogueInEffect, db: Database): Promise<FetchedTemplate> {
  const { id, version } = entry.facts;
  await downloads.seam.transfer?.(keyOf(id, version));
  currentTrustedOperation()?.enterStage("template download");
  requireCatalogueAt(where, db);
  admitStorageWrite(entry.size);
  const scratch = path.join(ingestScratchDir(), `template-${randomUUID()}`);
  // The scratch goes whatever happened, on the download's cleanup path: once
  // the version is installed, a failed removal is logged, never answered.
  currentTrustedOperation()?.defer(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(scratch, { recursive: true });
  const archive = path.join(scratch, "archive.zip");
  const landed = await transferTemplateArchive(entry, where, archive);
  await installTemplateArchive(scope, scratch, archive, { id, version, size: landed.size, sha256: landed.sha256 }, archiveOrigin(where));
  return { id, version, size: landed.size, downloaded: true };
}

/** Queue a download, or other work on the downloaded versions, behind
 * every one before it. */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const { running, result } = trustedQueueTurn(downloads.tail, work);
  downloads.tail = running.then(() => {}, () => {});
  return result;
}

/** Run `work` in a turn of its own among the downloads: no download
 * installs, or moves a folder aside, while it runs. */
export function inDownloadTurn<T>(work: () => Promise<T>): Promise<T> {
  return enqueue(work);
}

/**
 * Fetch a template's version: the one named, else the one its card takes
 * now. Installed, answered at once; listed and absent, downloaded once
 * however many callers ask together, and installed only once every check
 * passed. Refused, coded, leaving nothing.
 */
export async function fetchTemplate(
  scope: AccountScope,
  id: string,
  version: number | null,
  db: Database = metadataDb(),
  signal?: AbortSignal,
): Promise<FetchedTemplate> {
  return withTrustedMutation({ kind: "template-install", name: "Template installation", signal }, async operation => {
    const target = await fetchTarget(id, version, db);
    operation.enterStage("template preparation");
    if (target.kind === "installed") return { id, version: target.version, size: target.size, downloaded: false };
    const { entry, where } = target;
    const key = keyOf(id, entry.facts.version);
    const joined = downloads.byKey.get(key);
    if (joined) {
      downloads.seam.entered?.(key);
      operation.defer(() => joined.drained);
      return joined.join();
    }
    // The installed version is every waiting caller's whole result, so its
    // commit is theirs.
    const work = sharedTrustedWork({ kind: "template-install", name: "Template download" }, async (): Promise<FetchedTemplate> => {
      // Asked once more now that this caller holds the version's place: a
      // download of it that ended after the first look has installed it.
      const size = await downloadedSize(id, entry.facts.version);
      currentTrustedOperation()?.assertCanCommit();
      if (size !== null) return { id, version: entry.facts.version, size, downloaded: false };
      downloads.seam.entered?.(key);
      return enqueue(() => download(scope, entry, where, db));
    }, { commitsJoiners: true });
    downloads.byKey.set(key, work);
    const settled = () => { if (downloads.byKey.get(key) === work) downloads.byKey.delete(key); };
    work.value.then(settled, settled);
    operation.defer(() => work.drained);
    return work.join();
  });
}
