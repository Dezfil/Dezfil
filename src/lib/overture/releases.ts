/**
 * Overture release discovery (the release picker is honest). The public
 * bucket is listed over plain https (anonymous ListObjectsV2 with a
 * delimiter — releases are common prefixes); results are cached
 * in-process. Offline, a pinned fallback keeps the pane usable; the
 * import itself will then fail honestly if the bucket is unreachable.
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

let cache: { at: number; releases: string[] } | null = null;

export function parseReleaseListing(xml: string): string[] {
  const out: string[] = [];
  const re = /<Prefix>release\/([^<]+)\/<\/Prefix>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (RELEASE_PATTERN.test(m[1])) out.push(m[1]);
  }
  return out.sort().reverse();
}

export async function listOvertureReleases(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.releases;
  try {
    const response = await fetch(listUrl(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`listing responded ${response.status}`);
    const releases = parseReleaseListing(await response.text());
    if (releases.length === 0) throw new Error("no releases in listing");
    cache = { at: Date.now(), releases };
    return releases;
  } catch {
    return FALLBACK_RELEASES;
  }
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
