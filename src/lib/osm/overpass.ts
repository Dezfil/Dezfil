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
import { normalizeQl } from "./query";

/**
 * The Overpass client. The endpoint is administrator-configured — never
 * user-supplied per request; public instances rate-limit per IP, and every
 * error says so honestly. Responses cache on disk keyed by endpoint +
 * normalized query; refresh bypasses the cache by design.
 */

export const DEFAULT_OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

export function overpassEndpoint(): string {
  return process.env.DEZFIL_OVERPASS_URL || DEFAULT_OVERPASS_ENDPOINT;
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
  const finish = await beginProviderCacheWrite(generation); if (!finish) return;
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
  const key = cacheKey(endpoint, ql);
  if (!options.bypassCache) {
    const cached = await readCache(key);
    if (cached) return { response: cached, fromCache: true };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Public Overpass instances refuse anonymous user agents (406).
        "user-agent": "Dezfil/0.1 (self-hosted spatial SQL builder)",
      },
      body: `data=${encodeURIComponent(ql)}`,
      signal: AbortSignal.timeout((limits.overpassTimeoutS + 30) * 1000),
    });
  } catch (error) {
    throw new ApiError(
      "remote_fetch_failed",
      `Could not reach the Overpass endpoint ${endpoint}: ${
        error instanceof Error ? error.message : "network error"
      }`,
      502,
    );
  }

  if (response.status === 429) {
    throw new ApiError(
      "rate_limited",
      `The Overpass endpoint ${endpoint} rate-limited this request (public instances limit per IP). Wait a moment and retry, or configure DEZFIL_OVERPASS_URL to your own instance.`,
      429,
    );
  }
  if (response.status === 504) {
    throw new ApiError(
      "remote_fetch_failed",
      "The Overpass endpoint timed out on this query. Narrow the area or the tags and retry.",
      502,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = /<p><strong[^>]*>(.*?)<\/strong>/s.exec(text)?.[1];
    throw new ApiError(
      "remote_fetch_failed",
      `The Overpass endpoint responded ${response.status}${
        detail ? `: ${detail.slice(0, 300)}` : ""
      }`,
      502,
    );
  }

  // The outgoing query asks the server to honour [maxsize:…]; the same
  // promise is kept locally with slack — the response streams against a
  // bound instead of buffering without limit.
  const localBound = limits.overpassMaxsizeMb * 2 * 1024 * 1024;
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > localBound) {
        await reader.cancel().catch(() => {});
        throw new ApiError(
          "remote_too_large",
          `The Overpass response exceeded the local bound of ${Math.round(
            localBound / (1024 * 1024),
          )} MB (2× DEZFIL_OVERPASS_MAXSIZE_MB). Narrow the area or the tags and retry.`,
          413,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
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
