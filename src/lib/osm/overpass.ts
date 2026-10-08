import { beginProviderCacheWrite, providerCacheGeneration } from "@/lib/provider-cache-generation";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  readdir,
  unlink,
} from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { ApiError } from "@/lib/api/errors";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote, transportCode, type RemoteResponse } from "@/lib/net/remote-fetch";
import { settingRemedy } from "@/lib/settings/remedy";
import { addressOrigin, resolveServiceAddress } from "@/lib/settings/service-address";
import { normalizeQl } from "./query";

/**
 * The Overpass client. The endpoint is administrator-configured — never
 * user-supplied per request; public instances rate-limit per IP, and every
 * error says so honestly. Responses cache on disk keyed by endpoint +
 * normalized query; refresh bypasses the cache by design.
 *
 * The endpoint may carry a key (in its user information, path or query), so
 * what any refusal names is its scheme and host alone.
 *
 * The query goes through the outbound engine like every other request the
 * server makes for a person: the endpoint, and each redirect hop, must pass
 * the egress check before anything is sent, so a server in private space
 * answers only once the deployment's allowlist names it.
 */

export const DEFAULT_OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

/** The endpoint in effect: the variable when set, else the address an admin
 * stored, else the public server. A stored address the instance's key no
 * longer opens refuses with a coded error and never reaches the public
 * server instead. */
export function overpassEndpoint(): string {
  return resolveServiceAddress("overpassUrl").address ?? DEFAULT_OVERPASS_ENDPOINT;
}

/** What a refusal may say about the endpoint: its scheme and host. */
function shown(endpoint: string): string {
  return addressOrigin(endpoint) ?? "configured";
}

/** The parts of an address that may carry a key: its user information,
 * its whole path and query, each query value, and each path segment long
 * enough to be one. */
function secretParts(endpoint: string): string[] {
  try {
    const url = new URL(endpoint);
    return [url.username, url.password, url.pathname.length > 1 ? url.pathname : "", url.search.slice(1),
      ...[...url.searchParams.values()], ...url.pathname.split("/").filter(segment => segment.length >= 12)]
      .filter(part => part.length >= 4);
  } catch { return [endpoint]; }
}

export interface OverpassResponse {
  elements: unknown[];
  remark?: string;
}

function cacheDir(): string {
  return path.join(dataDir(), "cache", "overpass");
}

export function cacheKey(endpoint: string, ql: string): string {
  return createHash("sha256")
    .update(endpoint)
    .update("\n")
    .update(normalizeQl(ql))
    .digest("hex");
}

async function readCache(key: string): Promise<OverpassResponse | null> {
  const file = path.join(cacheDir(), `${key}.json`);
  try {
    const info = await stat(file);
    const ttlMs = limits.overpassCacheHours * 60 * 60 * 1000;
    if (Date.now() - info.mtimeMs > ttlMs) {
      // A stale entry is removed, not merely ignored.
      await unlink(file).catch(() => {});
      return null;
    }
    return JSON.parse(await readFile(file, "utf8")) as OverpassResponse;
  } catch {
    return null;
  }
}

/**
 * Cache maintenance: TTL-expired entries are unlinked, then oldest-first
 * eviction holds the cache under its size budget. Runs around the cache's
 * own writes — never from a boot sweep; this cache is durable by design
 * and shrinks by TTL, budget and account erasure.
 */
export async function maintainOverpassCache(): Promise<void> {
  try {
    const dir = cacheDir();
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const ttlMs = limits.overpassCacheHours * 60 * 60 * 1000;
    const now = Date.now();
    const kept: { file: string; mtimeMs: number; size: number }[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (now - info.mtimeMs > ttlMs) {
          await unlink(file);
        } else {
          kept.push({ file, mtimeMs: info.mtimeMs, size: info.size });
        }
      } catch {
        /* Raced away — another writer or prune got here first */
      }
    }
    const budget = limits.overpassCacheMb * 1024 * 1024;
    let total = kept.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= budget) return;
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of kept) {
      if (total <= budget) break;
      try {
        await unlink(entry.file);
        total -= entry.size;
      } catch {
        /* Best-effort, like the cache itself */
      }
    }
  } catch {
    /* Maintenance never fails an import */
  }
}

async function writeCache(key: string, body: OverpassResponse, generation: number): Promise<void> {
  const finish = await beginProviderCacheWrite(generation, "overpass"); if (!finish) return;
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(path.join(cacheDir(), `${key}.json`), JSON.stringify(body));
    await maintainOverpassCache();
  } catch {
    /* A failed cache write never fails an import */
  } finally { finish(); }
}

/** Fetch a query, cached. `bypassCache` re-hits the endpoint (refresh). */
export async function fetchOverpass(
  ql: string,
  options: { bypassCache?: boolean } = {},
): Promise<{ response: OverpassResponse; fromCache: boolean }> {
  const generation = providerCacheGeneration();
  const endpoint = overpassEndpoint();
  const origin = shown(endpoint);
  const key = cacheKey(endpoint, ql);
  if (!options.bypassCache) {
    const cached = await readCache(key);
    if (cached) return { response: cached, fromCache: true };
  }

  // The query's own time budget, and time to send its answer: the deadline
  // covers the whole exchange, the answer's body included.
  const deadlineS = limits.overpassTimeoutS + 30;
  const pastDeadline = new ApiError(
    "remote_fetch_failed",
    `The Overpass endpoint ${origin} did not answer within ${deadlineS} s.`,
    502,
  );
  let response: RemoteResponse;
  try {
    response = await openRemote(endpoint, {
      method: "POST",
      body: `data=${encodeURIComponent(ql)}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Public Overpass instances refuse anonymous user agents (406).
        "user-agent": "Dezfil/0.1 (self-hosted spatial SQL builder)",
      },
      timeoutMs: deadlineS * 1000,
      timeoutError: () => pastDeadline,
    });
  } catch (error) {
    // The egress check's refusal and the deadline name no address; the
    // engine's other failures repeat the whole address, so only the
    // transport's code (a refused connection, a name that does not resolve)
    // travels.
    if (error === pastDeadline || (error instanceof ApiError && error.code === "egress_blocked")) throw error;
    const code = transportCode(error);
    throw new ApiError(
      "remote_fetch_failed",
      `Could not reach the Overpass endpoint ${origin}${code ? ` (${code})` : ""}.`,
      502,
    );
  }

  const status = response.statusCode;
  if (status === 429) {
    response.body.destroy();
    throw new ApiError(
      "rate_limited",
      `The Overpass endpoint ${origin} rate-limited this request (public instances limit per IP). Wait a moment and retry, or point it at your own instance. ${settingRemedy("overpassUrl")}`,
      429,
    );
  }
  if (status === 504) {
    response.body.destroy();
    throw new ApiError(
      "remote_fetch_failed",
      "The Overpass endpoint timed out on this query. Narrow the area or the tags and retry.",
      502,
    );
  }
  if (status < 200 || status >= 300) {
    const text = (await readCapped(response.body, 64 * 1024).catch(() => null)) ?? "";
    const found = /<p><strong[^>]*>(.*?)<\/strong>/s.exec(text)?.[1]?.slice(0, 300);
    // The server's own words, unless they repeat a part of the address that
    // may carry a key: then the status alone.
    const detail = found && !secretParts(endpoint).some(part => found.includes(part)) ? found : undefined;
    throw new ApiError(
      "remote_fetch_failed",
      `The Overpass endpoint ${origin} responded ${status}${
        detail ? `: ${detail}` : ""
      }`,
      502,
    );
  }

  // The outgoing query asks the server to honour [maxsize:…]; the same
  // promise is kept locally with slack — the response streams against a
  // bound instead of buffering without limit.
  const localBound = limits.overpassMaxsizeMb * 2 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Buffer>) {
      received += chunk.length;
      if (received > localBound) {
        response.body.destroy();
        throw new ApiError(
          "remote_too_large",
          `The Overpass response exceeded the local bound of ${Math.round(
            localBound / (1024 * 1024),
          )} MB (2× DEZFIL_OVERPASS_MAXSIZE_MB). Narrow the area or the tags and retry.`,
          413,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    // The bound's refusal and the deadline name no address; a transfer cut
    // short says so without the transport's words.
    if (error instanceof ApiError) throw error;
    throw new ApiError("remote_fetch_failed", `The Overpass endpoint ${origin} stopped sending its answer.`, 502);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: OverpassResponse;
  try {
    body = JSON.parse(text) as OverpassResponse;
  } catch {
    throw new ApiError(
      "remote_fetch_failed",
      "The Overpass endpoint returned a non-JSON response, likely an overload page. Retry shortly.",
      502,
    );
  }
  if (body.remark && /error/i.test(body.remark)) {
    throw new ApiError(
      "remote_fetch_failed",
      `Overpass reported: ${body.remark}. Narrow the area or the tags and retry.`,
      502,
    );
  }

  await writeCache(key, body, generation);
  return { response: body, fromCache: false };
}
