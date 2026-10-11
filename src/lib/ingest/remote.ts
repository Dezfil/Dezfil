import { settingRemedy } from "@/lib/settings/remedy";
import { resolveServiceAddress } from "@/lib/settings/service-address";
import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { registerAccountFile, removeAccountFile } from "./file-ownership";
import { requireFilingDestination } from "@/lib/auth/reach";
import { requireRule } from "@/lib/auth/instance-rules";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataDir } from "@/lib/config";
import { captureIngestBudget, type IngestBudget } from "./budget";
import { ApiError } from "@/lib/api/errors";
import { openRemote, type OpenRemoteOptions, type RemoteResponse } from "@/lib/net/remote-fetch";
import { withConnection } from "@/lib/duckdb";
import { detectFormat } from "./ingest";
import { ingestSource, type IngestResult } from "./gdal-formats";

/**
 * Remote-file import (From URL; admission hardened). Every URL streams
 * through Node on one road — egress-policy-checked, byte-capped
 * mid-flight — with object stores addressed anonymously via their public
 * HTTPS form. The administrator credential opt-in alone switches object
 * stores to DuckDB's credential-chain road. Either way the result walks
 * the same ingest road as an upload.
 */

const SCHEMES = ["https:", "http:", "s3:", "gs:", "az:"] as const;
type Scheme = (typeof SCHEMES)[number];

export interface RemoteRef {
  url: string;
  scheme: Scheme;
  /** Last path segment — carries the extension that decides the format. */
  filename: string;
}

export function parseRemoteUrl(raw: string): RemoteRef {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError(
      "invalid_request",
      `"${raw}" is not a valid URL.`,
      400,
    );
  }
  if (!SCHEMES.includes(parsed.protocol as Scheme)) {
    throw new ApiError(
      "invalid_request",
      `Unsupported URL scheme "${parsed.protocol}". Supported: https://, http://, s3://, gs://, az://.`,
      400,
    );
  }
  const filename = decodeURIComponent(
    parsed.pathname.split("/").filter(Boolean).pop() ?? "",
  );
  if (!filename) {
    throw new ApiError(
      "invalid_request",
      "The URL has no file path. Point it at a Parquet, CSV, GeoJSON, Shapefile-zip, GeoPackage, or KML file.",
      400,
    );
  }
  // Fail fast on unsupported extensions, before any fetch.
  detectFormat(filename);
  return { url: raw, scheme: parsed.protocol as Scheme, filename };
}

function capMb(budget: IngestBudget): number {
  return Math.round(budget.remoteMaxBytes / (1024 * 1024));
}

/** Stream an http(s) file to a temp path, enforcing the cap mid-flight.
 * The fetch goes through the egress engine: every redirect hop re-enters
 * the address policy before it is contacted.
 *
 * `shown` is what a refusal names. For a web address it is the address; for
 * a cloud-storage link it is the person's own link, never the address it was
 * reached at, which may be an admin's with a key in it. Then a transport
 * failure says only that the store could not be reached, since the engine's
 * own sentence repeats the address it tried. */
async function downloadHttp(url: string, tmpPath: string, budget: IngestBudget, shown = url): Promise<void> {
  const reached = shown === url;
  let response: Awaited<ReturnType<typeof openRemote>>;
  try {
    response = await openRemote(url, {
      timeoutMs: budget.remoteTimeoutMs,
      timeoutError: () =>
        new ApiError(
          "remote_timeout",
          `The download from ${shown} exceeded the remote time bound of ${Math.round(
            budget.remoteTimeoutMs / 1000,
          )} s. ${settingRemedy("remoteTimeoutS")}`,
          504,
        ),
    });
  } catch (error) {
    if (!reached && error instanceof ApiError && error.code === "remote_fetch_failed") {
      throw new ApiError("remote_fetch_failed", `Could not reach the cloud storage holding ${shown}.`, 502);
    }
    throw error;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.body.destroy();
    throw new ApiError(
      "remote_fetch_failed",
      `The server responded ${response.statusCode} for ${shown}.`,
      502,
    );
  }
  const declared = Number(response.headers["content-length"] ?? 0);
  if (declared > budget.remoteMaxBytes) {
    response.body.destroy();
    throw new ApiError(
      "remote_too_large",
      `The remote file is ${Math.round(declared / (1024 * 1024))} MB; the cap is ${capMb(budget)} MB. ${settingRemedy("remoteMaxMb")}`,
      413,
    );
  }
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > budget.remoteMaxBytes) {
        cb(
          new ApiError(
            "remote_too_large",
            `The remote file exceeds the cap of ${capMb(budget)} MB. ${settingRemedy("remoteMaxMb")}`,
            413,
          ),
        );
      } else {
        cb(null, chunk);
      }
    },
  });
  try {
    await pipeline(response.body, counter, createWriteStream(tmpPath));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "remote_fetch_failed",
      `The download from ${shown} was interrupted${
        reached ? `: ${error instanceof Error ? error.message : "stream error"}` : "."
      }`,
      502,
    );
  }
}

/** Load the DuckDB extension an object-store scheme needs, honestly. */
async function ensureObjectStoreSupport(
  conn: import("@duckdb/node-api").DuckDBConnection,
  scheme: Scheme,
): Promise<void> {
  const extension = scheme === "az:" ? "azure" : "httpfs";
  try {
    await conn.run(`INSTALL ${extension}; LOAD ${extension};`);
  } catch (error) {
    throw new ApiError(
      "remote_fetch_failed",
      `Reading ${scheme}// URLs needs the DuckDB ${extension} extension, which could not be loaded${
        error instanceof Error ? `: ${error.message}` : ""
      }`,
      502,
    );
  }
  if (scheme === "s3:") {
    // Administrator credentials from the environment (AWS credential chain).
    // Public buckets work without; failure to create the secret is not
    // an error by itself.
    try {
      await conn.run(
        `CREATE SECRET IF NOT EXISTS dezfil_s3 (TYPE s3, PROVIDER credential_chain)`,
      );
    } catch {
      /* Aws extension unavailable — anonymous access still works */
    }
  }
}

/** Map a DuckDB read failure on a remote source to an honest error. */
function mapObjectStoreError(url: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError && error.code !== "malformed_file") throw error;
  if (
    /HTTP|40[0-9]|50[0-9]|Connection|resolve|timed? ?out|credential|Access Denied|No files found/i.test(
      message,
    )
  ) {
    throw new ApiError(
      "remote_fetch_failed",
      `Could not fetch ${url}: ${message}. Private buckets need credentials configured in the server environment.`,
      502,
    );
  }
  throw error;
}

export interface ResolvedRemoteSource {
  budget: IngestBudget;
  /** Path handed to the ingest pipeline — a temp file or the URL itself. */
  sourcePath: string;
  filename: string;
  cleanup: () => Promise<void>;
}

/** Administrator opt-in: sign object-store reads with the instance's credential
 * chain. Off by default — the server fetches user-supplied objects as
 * nobody. */
export function objectStoreCredentialsEnabled(): boolean {
  const value = (
    process.env.DEZFIL_OBJECT_STORE_CREDENTIALS ?? ""
  ).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** The S3 address in effect, or null for Amazon S3's own addresses; a
 * stored one the instance's key no longer opens refuses. */
function s3Address(): string | null {
  return resolveServiceAddress("s3Endpoint").address;
}

/** A path under the S3 address: the address's own path, then this one. Its
 * user information and its query, where a key may travel, stay where they
 * are. Text that is not an address is joined as written, and refused where
 * it is used. */
function underS3Address(address: string, subpath: string): string {
  let url: URL;
  try { url = new URL(address); } catch { return `${address.replace(/\/$/, "")}${subpath}`; }
  url.pathname = `${url.pathname.replace(/\/$/, "")}${subpath}`;
  return url.toString();
}

/**
 * The public HTTPS form of an s3:// or gs:// URL — the anonymous road.
 * The S3 address in effect (DEZFIL_S3_ENDPOINT, else the one an admin
 * stored) points s3:// at a custom store (MinIO and friends), path-style;
 * a stored one the instance's key no longer opens refuses rather than
 * reach Amazon's instead.
 */
export function translateObjectUrl(ref: RemoteRef): string {
  const parsed = new URL(ref.url);
  const bucket = parsed.hostname;
  const key = parsed.pathname;
  if (ref.scheme === "gs:") {
    return `https://storage.googleapis.com/${bucket}${key}`;
  }
  const custom = s3Address();
  if (custom) return underS3Address(custom, `/${bucket}${key}`);
  // Virtual-hosted style; buckets with dots break the TLS wildcard, so
  // they fall back to path-style on the global endpoint.
  return bucket.includes(".")
    ? `https://s3.amazonaws.com/${bucket}${key}`
    : `https://${bucket}.s3.amazonaws.com${key}`;
}

/**
 * One unsigned request to the S3 address's root (the address in effect, else
 * Amazon S3's own), on the anonymous road's terms: the outbound engine with
 * every redirect hop checked, and the link import time limit. A stored
 * address the instance's key no longer opens refuses rather than reach
 * Amazon's instead. Cloud storage's Test sends through here.
 */
export function openS3AddressRoot(options: Pick<OpenRemoteOptions, "timeoutError" | "onRedirect">): Promise<RemoteResponse> {
  const custom = s3Address();
  return openRemote(custom ? underS3Address(custom, "/") : "https://s3.amazonaws.com/",
    { timeoutMs: captureIngestBudget().remoteTimeoutMs, ...options });
}

/** Stream a URL into the ingest scratch directory under the cap. */
async function downloadToScratch(
  url: string,
  filename: string,
  accountId: string | undefined,
  budget: IngestBudget,
  shown = url,
): Promise<ResolvedRemoteSource> {
  const tmpDir = path.join(dataDir(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${randomUUID()}${path.extname(filename)}`);
  if (accountId) registerAccountFile(accountId, tmpPath);
  try {
    await downloadHttp(url, tmpPath, budget, shown);
  } catch (error) {
    await removeAccountFile(tmpPath, { force: true });
    throw error;
  }
  return {
    sourcePath: tmpPath,
    budget,
    filename,
    cleanup: () => removeAccountFile(tmpPath, { force: true }),
  };
}

/**
 * Make a remote URL readable by the ingest pipeline. Http(s) URLs — and,
 * anonymously, object-store URLs via their public HTTPS form — stream to a
 * temp file on one capped, policy-checked road. Only the administrator
 * credential opt-in switches object stores to DuckDB's credential-chain
 * road.
 */
export async function resolveRemoteSource(
  raw: string,
  accountId?: string,
): Promise<ResolvedRemoteSource> {
  const budget = captureIngestBudget();
  const ref = parseRemoteUrl(raw);
  const format = detectFormat(ref.filename);

  if (ref.scheme === "https:" || ref.scheme === "http:") {
    return downloadToScratch(ref.url, ref.filename, accountId, budget);
  }

  if (!objectStoreCredentialsEnabled()) {
    // Anonymous by default: no credential ever signs a user-supplied
    // read. az:// cannot be addressed without administrator account config, so
    // anonymously it is refused toward the https:// form that works.
    if (ref.scheme === "az:") {
      throw new ApiError(
        "invalid_request",
        "az:// URLs need the credential opt-in (DEZFIL_OBJECT_STORE_CREDENTIALS). A public Azure blob imports anonymously via its https:// URL.",
        400,
      );
    }
    try {
      return await downloadToScratch(translateObjectUrl(ref), ref.filename, accountId, budget, ref.url);
    } catch (error) {
      if (error instanceof ApiError && error.code === "remote_fetch_failed") {
        throw new ApiError(
          error.code,
          `${error.message} If this is a private bucket, credentialed reads can be enabled with DEZFIL_OBJECT_STORE_CREDENTIALS.`,
          error.status,
        );
      }
      throw error;
    }
  }

  return resolveCredentialedObjectSource(ref, format, accountId, budget);
}

/** Best-effort anonymous size probe against the object's HTTPS form. A
 * store that answers a HEAD lets the cap fire before anything is read;
 * one that refuses (private objects, az://) yields null — the documented
 * per-scheme residual of the credentialed road. A stored S3 address the
 * instance's key no longer opens is not a store's answer: it refuses the
 * read, as it does on the anonymous road. */
async function probeObjectSize(ref: RemoteRef): Promise<number | null> {
  if (ref.scheme === "az:") return null;
  const address = translateObjectUrl(ref);
  try {
    const response = await openRemote(address, {
      method: "HEAD",
      timeoutMs: 10_000,
    });
    response.body.resume();
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    const length = Number(response.headers["content-length"] ?? NaN);
    return Number.isFinite(length) ? length : null;
  } catch {
    return null;
  }
}

/** The administrator-opt-in road: DuckDB reads the object with the instance's
 * credential chain, as — Parquet/CSV straight off the URL, GeoJSON via
 * read_blob into a temp file. The probe above bounds whatever announces its
 * size, before DuckDB or a credential is touched. */
async function resolveCredentialedObjectSource(
  ref: RemoteRef,
  format: ReturnType<typeof detectFormat>,
  accountId: string | undefined,
  budget: IngestBudget,
): Promise<ResolvedRemoteSource> {
  const probed = await probeObjectSize(ref);
  if (probed !== null && probed > budget.remoteMaxBytes) {
    throw new ApiError(
      "remote_too_large",
      `The remote object is ${Math.round(probed / (1024 * 1024))} MB; the cap is ${capMb(budget)} MB. ${settingRemedy("remoteMaxMb")}`,
      413,
    );
  }
  await withConnection((conn) => ensureObjectStoreSupport(conn, ref.scheme));
  // Parquet/CSV read straight off the URL. GeoJSON — and the container
  // formats, which must be local files before extraction/GDAL — land in
  // scratch via read_blob first.
  if (format === "geoparquet" || format === "csv") {
    return { sourcePath: ref.url, budget, filename: ref.filename, cleanup: async () => {} };
  }

  const tmpDir = path.join(dataDir(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(
    tmpDir,
    `${randomUUID()}${path.extname(ref.filename)}`,
  );
  if (accountId) registerAccountFile(accountId, tmpPath);
  try {
    const blob = await withConnection(async (conn) => {
      await ensureObjectStoreSupport(conn, ref.scheme);
      try {
        const read = await conn.runAndReadAll(
          `SELECT content, size FROM read_blob('${ref.url.replace(/'/g, "''")}')`,
        );
        return read.getRowObjects()[0] as unknown as {
          content: Uint8Array;
          size: number | bigint;
        };
      } catch (error) {
        mapObjectStoreError(ref.url, error);
      }
    });
    if (Number(blob.size) > budget.remoteMaxBytes) {
      throw new ApiError(
        "remote_too_large",
        `The remote file is ${Math.round(Number(blob.size) / (1024 * 1024))} MB; the cap is ${capMb(budget)} MB. ${settingRemedy("remoteMaxMb")}`,
        413,
      );
    }
    // read_blob materializes the object in engine memory before this
    // write — the documented residual of the credentialed opt-in road
    // (registry: the anonymous road streams; this one buffers up to the
    // remote cap). Written without an extra Buffer copy.
    await writeFile(tmpPath, blob.content);
    return {
      sourcePath: tmpPath,
      budget,
      filename: ref.filename,
      cleanup: () => removeAccountFile(tmpPath, { force: true }),
    };
  } catch (error) {
    await removeAccountFile(tmpPath, { force: true });
    throw error;
  }
}

/** Import a remote file as one or more tables (spec From URL,
 * materialized; container formats fan out per layer). A new import from a
 * link, web address or cloud storage alike, is admitted by who may import
 * from links before any request leaves and asked again where it registers;
 * refreshing a link dataset is not an import and keeps working whatever the
 * rule says. */
export async function importFromUrl(
  scope: AccountScope,
  url: string,
  requestedName?: string,
  projectId?: string | null,
): Promise<IngestResult> {
  const deletionWork = admitAccountWork([requireAccountScope(scope)]);
  try {
  requireAccountScope(scope);
  requireRule(scope.accountId, "imports.links");
  if (projectId) requireFilingDestination(scope, projectId);
  const source = await resolveRemoteSource(url, scope.accountId);
  try {
    return await ingestSource(
      scope,
      source.sourcePath,
      source.filename,
      { source: "url", sourceParams: { url }, projectId },
      requestedName,
      source.budget,
    );
  } catch (error) {
    if (source.sourcePath === url) mapObjectStoreError(url, error);
    throw error;
  } finally {
    await source.cleanup();
  }

  } finally { deletionWork.release(); }
}
