import { ApiError } from "@/lib/api/errors";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote } from "@/lib/net/remote-fetch";

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

export const OVERTURE_BUCKET = "overturemaps-us-west-2";
export const OVERTURE_REGION = "us-west-2";
export const OVERTURE_S3_BASE = `s3://${OVERTURE_BUCKET}/release`;

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
 * One listing of the releases, newest first, with no list kept and no
 * fallback: the egress check's refusal as it is, anything else (no answer,
 * a status, an answer with no release in it) as a coded failure.
 */
export async function requestReleaseListing(): Promise<string[]> {
  const response = await openRemote(listUrl(), {
    timeoutMs: LISTING_TIMEOUT_MS,
    timeoutError: () => listingFailed(`no answer within ${LISTING_TIMEOUT_MS / 1000} s`),
  });
  if (response.statusCode !== 200) {
    response.body.destroy();
    throw listingFailed(`status ${response.statusCode}`);
  }
  const text = await readCapped(response.body, LISTING_MAX_BYTES);
  const releases = text === null ? [] : parseReleaseListing(text);
  if (releases.length === 0) throw listingFailed("no release in the answer");
  return releases;
}

/**
 * The releases the pane offers: the list kept in this process while it is
 * fresh, else a new listing, kept. `refresh` (Check now) asks again past the
 * kept list. An outage gives the pinned fallback; the egress check's refusal
 * is passed on.
 */
export async function listOvertureReleases(options: { refresh?: boolean } = {}): Promise<string[]> {
  if (!options.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.releases;
  return requestReleaseListing().then(keep, (error: unknown) => {
    if (error instanceof ApiError && error.code === "egress_blocked") throw error;
    return FALLBACK_RELEASES;
  });
}

/** Keep a listing as the list this process offers. */
function keep(releases: string[]): string[] {
  cache = { at: Date.now(), releases };
  return releases;
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
