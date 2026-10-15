import { withTrustedOperation } from "@/lib/trusted-operation";
import { currentTrustedOperation, isTrustedOperationRefusal } from "@/lib/trusted-operation";
import { ApiError } from "@/lib/api/errors";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote } from "@/lib/net/remote-fetch";
import { OVERTURE_BUCKET, OVERTURE_REGION } from "./bucket";

/**
 * Overture release discovery (the release picker is honest). The public
 * bucket is listed over plain https (anonymous ListObjectsV2 with a
 * delimiter — releases are common prefixes); results are cached
 * in-process. Offline, a pinned fallback keeps the pane usable; the
 * import itself will then fail honestly if the bucket is unreachable.
 *
 * The listing goes through the outbound engine, so the listing address and
 * each redirect hop pass the egress check before anything is sent: a mirror
 * in private space is listed once the deployment's allowlist names it, and
 * refused while it does not. A refusal is not an outage and gets no
 * fallback, which would offer releases this deployment cannot read.
 */

/** The listing endpoint. DEZFIL_OVERTURE_S3_ENDPOINT (test seam, the
 * Overpass-URL analog) swaps the public bucket for a local S3-compatible
 * fixture — path-style, plain http. Read lazily so tests can set it. */
function listUrl(): string {
  const seam = process.env.DEZFIL_OVERTURE_S3_ENDPOINT;
  return seam
    ? `http://${seam}/${OVERTURE_BUCKET}/?list-type=2&prefix=release/&delimiter=/`
    : `https://${OVERTURE_BUCKET}.s3.${OVERTURE_REGION}.amazonaws.com/?list-type=2&prefix=release/&delimiter=/`;
}

/** Known-good releases if the bucket cannot be listed (checked 2026-07). */
const FALLBACK_RELEASES = ["2026-06-17.0", "2026-05-20.0"];

const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LISTING_TIMEOUT_MS = 10_000;
/** A listing of release prefixes is a few kilobytes; far more is not one. */
const LISTING_MAX_BYTES = 1_000_000;

let cache: { at: number; releases: string[] } | null = null;

export function parseReleaseListing(xml: string): string[] {
  const out: string[] = [];
  const re = /<Prefix>release\/([^<]+)\/<\/Prefix>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (RELEASE_PATTERN.test(m[1])) out.push(m[1]);
  }
  return out.sort().reverse();
}

function listingFailed(detail: string): ApiError {
  return new ApiError("remote_fetch_failed", `The Overture release listing failed: ${detail}.`, 502);
}

/**
 * One listing, sent: no list looked up or kept. Through the outbound engine,
 * so the listing address and each redirect hop pass the egress check before
 * anything is sent. The releases it names, newest first, for a 200 (none
 * when the answer names none); the body closed otherwise. The pane's
 * listing and Overture's Test send through here.
 */
export async function sendReleaseListing(timeoutError: () => ApiError): Promise<{ statusCode: number; releases: string[] }> {
  const read = async () => {
    const response = await openRemote(listUrl(), { timeoutMs: LISTING_TIMEOUT_MS, timeoutError, signal: currentTrustedOperation()?.signal });
    if (response.statusCode !== 200) {
      response.body.destroy();
      return { statusCode: response.statusCode, releases: [] };
    }
    const text = await readCapped(response.body, LISTING_MAX_BYTES);
    currentTrustedOperation()?.assertCanCommit();
    return { statusCode: 200, releases: text === null ? [] : parseReleaseListing(text) };
  };
  // The caller may handle an outage with a fallback before deciding its outcome.
  return currentTrustedOperation() ? read() : withTrustedOperation({ kind: "interactive-read", name: "Overture releases" }, read);
}

/**
 * One listing of the releases, newest first, with no list kept and no
 * fallback: the egress check's refusal as it is, anything else (no answer,
 * a status, an answer with no release in it) as a coded failure.
 */
export async function requestReleaseListing(): Promise<string[]> {
  const { statusCode, releases } = await sendReleaseListing(() => listingFailed(`no answer within ${LISTING_TIMEOUT_MS / 1000} s`));
  if (statusCode !== 200) throw listingFailed(`status ${statusCode}`);
  if (releases.length === 0) throw listingFailed("no release in the answer");
  return releases;
}

/**
 * The releases the pane offers: the list kept in this process while it is
 * fresh, else a new listing, kept. `refresh` (Check now) asks again past the
 * kept list. An outage gives the pinned fallback; the egress check's refusal
 * is passed on.
 */
export async function listOvertureReleases(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture releases", signal: options.signal }, async () => {
    if (!options.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.releases;
    return requestReleaseListing().then(keepReleaseList, (error: unknown) => {
      currentTrustedOperation()?.assertCanCommit();
      if (isTrustedOperationRefusal(error) && (!(error instanceof ApiError) || error.code !== "remote_fetch_failed")) throw error;
      return FALLBACK_RELEASES;
    });
  });
}

/** Keep a listing as the list this process offers (a listing that named
 * at least one release; never the pinned fallback). */
export function keepReleaseList(releases: string[]): string[] {
  cache = { at: Date.now(), releases };
  return releases;
}

/** The list this process keeps, newest first, and when it was listed; null
 * before any listing succeeded. The pinned fallback is never kept. */
export function keptReleaseList(): { releases: string[]; listedAt: number } | null {
  return cache ? { releases: [...cache.releases], listedAt: cache.at } : null;
}

export async function latestOvertureRelease(): Promise<string> {
  return (await listOvertureReleases())[0];
}

export function isValidRelease(value: unknown): value is string {
  return typeof value === "string" && RELEASE_PATTERN.test(value);
}

/** Tests reset the cache. */
export function resetReleaseCache(): void {
  cache = null;
}
