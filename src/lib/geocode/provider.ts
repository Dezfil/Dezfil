import { ApiError } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote } from "@/lib/net/remote-fetch";
import { readAnswer, writeAnswer, type CachedAnswer } from "./cache";
import {
  USER_AGENT,
  configuredEndpoint,
  endpointKey,
  searchUrl,
} from "./endpoint";
import { takeSlot } from "./limiter";
import { normalizeAddress } from "./normalize";

/**
 * One address, answered.
 *
 * **The row outcomes and the run outcomes are different kinds of thing**, and
 * keeping them apart is this module's whole job. A row's failure is a row's
 * business: no match, an empty address, an answer this instance could not read
 * are recorded on the row and the run succeeds. A *transport* failure is not —
 * the provider not answering says nothing about the address, so publishing
 * `no_match` for it would be a fabricated answer. It is retried once, and then
 * it throws, which fails the whole run.
 *
 * `unreadable_answer` is deliberately not a synonym for `no_match`: the
 * provider answering something this instance could not read is a different fact
 * from the provider saying it has nothing, and collapsing them would report a
 * provider fault as an absent address.
 */

/** What happened to one row. */
export type RowOutcome =
  | "matched"
  | "no_match"
  | "empty_address"
  | "unreadable_answer";

export interface RowAnswer {
  outcome: RowOutcome;
  lon: number | null;
  lat: number | null;
  /** What the provider says it matched — its own display name. */
  display: string | null;
  attribution: string | null;
  /**
   * Where this answer came from — and **empty for a row that was never asked
   * about**, which is a third fact and not a kind of asking.
   */
  source: "cache" | "wire" | null;
}

/** The answer this instance could not read: kept off the cache deliberately —
 * it is a provider fault, and likely transient. */
const UNREADABLE: RowAnswer = {
  outcome: "unreadable_answer",
  lon: null,
  lat: null,
  display: null,
  attribution: null,
  source: "wire",
};

const EMPTY: RowAnswer = {
  outcome: "empty_address",
  lon: null,
  lat: null,
  display: null,
  attribution: null,
  source: null,
};

/** Bytes of one provider answer this instance will read. One address's answer
 * is a handful of kilobytes; past this the answer is not trusted at all. */
const MAX_BYTES = 1_000_000;

export interface AskOptions {
  signal?: AbortSignal;
  /**
   * When the caller's whole run must be over.
   *
   * **The wait for a slot is the reason this exists.** A batch checks its
   * deadline before deciding to ask, and then queues — behind its own pace, and
   * behind whatever else the instance is doing. That wait can outlast the run,
   * and without this the request would start anyway and then take its own full
   * deadline on top. Given one, the exchange is bounded by whichever comes
   * first.
   */
  deadlineAt?: number;
}

/** The caller's run ended while this address was waiting for a slot. Coded as a
 * cancellation rather than a provider fault: nobody failed to answer. */
function pastDeadline(): ApiError {
  return new ApiError(
    "remote_fetch_abandoned",
    "The request was abandoned before it started: the run that asked for it " +
      "had already reached its time bound.",
    499,
  );
}

export function unconfiguredError(): ApiError {
  return new ApiError(
    "geocoder_unconfigured",
    "No geocoding endpoint is configured on this instance, so addresses " +
      "cannot be looked up. Set DEZFIL_GEOCODER_URL and try again.",
    400,
  );
}

/**
 * The provider failed to answer, twice.
 *
 * **The message never names the endpoint** (J5): the configured URL may carry a
 * key, and this text reaches a job record, an API response and a screen.
 */
function providerFailed(detail: string): ApiError {
  return new ApiError(
    "geocoder_failed",
    `The configured geocoding endpoint did not answer (${detail}), twice in a ` +
      `row. Nothing was published: an address nobody could ask about is not an ` +
      `address that does not exist.`,
    502,
  );
}

interface WireEntry {
  display_name?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  licence?: unknown;
}

/** A coordinate from the wire: a finite number, from a number or a non-empty
 * string — `Number(null)` and `Number("")` are 0 and must not become a point at
 * null island. */
function wireNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The provider's answer, read into one row's outcome.
 *
 * **One candidate, chosen by the provider** (J3): the first entry it returned,
 * in its own ranking. A row per candidate would break one-row-out-per-row-in,
 * which is what makes the result usable without a join back.
 */
function readAnswerBody(text: string): CachedAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries = parsed as WireEntry[];
  if (entries.length === 0) {
    return { outcome: "no_match", answeredAt: new Date().toISOString() };
  }
  const first = entries[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return null;
  }
  const lat = wireNumber(first.lat);
  const lon = wireNumber(first.lon);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const display =
    typeof first.display_name === "string" && first.display_name !== ""
      ? first.display_name
      : typeof first.name === "string"
        ? first.name
        : "";
  // **A missing licence is not a fault here**, where interactive search treats
  // it as one. A search shows credit beside results on a screen and can refuse
  // to invent it; a geocode has already resolved a point, and turning a good
  // answer into a provider fault over an absent field would lose the address.
  // The column carries the absence instead.
  const attribution =
    typeof first.licence === "string" && first.licence !== ""
      ? first.licence
      : null;
  return {
    outcome: "matched",
    lon,
    lat,
    display,
    attribution,
    answeredAt: new Date().toISOString(),
  };
}

function fromCache(cached: CachedAnswer, source: "cache" | "wire"): RowAnswer {
  return {
    outcome: cached.outcome,
    lon: cached.lon ?? null,
    lat: cached.lat ?? null,
    display: cached.display ?? null,
    attribution: cached.attribution ?? null,
    source,
  };
}

/** One exchange with the provider. Throws for anything that is not an answer,
 * so the caller's retry sees transport failures and only those. Answers null
 * when the body was past the cap — the exchange worked, so that is a fault
 * about *this answer*, which is the row's business and not the run's. */
async function askOnce(
  endpoint: string,
  address: string,
  options: AskOptions,
): Promise<string | null> {
  const url = searchUrl(address, { limit: "1" });
  if (!url) throw unconfiguredError();
  const { signal, deadlineAt } = options;
  const release = await takeSlot(endpointKey(endpoint), "batch", signal);
  try {
    // **Checked again on the near side of the wait**. The wait is
    // for a slot, and a slot can open after the run that queued for it is over —
    // so the caller's deadline is honoured *here*, where the request would
    // otherwise start, and not only where the batch decided to ask.
    const left = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
    if (left !== undefined && left <= 0) throw pastDeadline();
    const response = await openRemote(url.toString(), {
      // The exchange may not outlive the run either: a request that starts with
      // a second of budget left takes a second, not its own full deadline.
      timeoutMs:
        left === undefined
          ? limits.geocodeRequestTimeoutMs
          : Math.min(limits.geocodeRequestTimeoutMs, left),
      // The engine's own timeout message embeds the URL, which may carry a key.
      // Coded here instead, so the deadline never reaches a job record as text
      // nobody sanitized.
      timeoutError: () => providerFailed("no answer inside the deadline"),
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (response.statusCode !== 200) {
      // **Destroyed, not drained.** `resume()` only starts the body flowing;
      // the throw below releases the slot immediately, so a provider that
      // sends error headers and then hangs would leave that exchange open
      // while the retry — or another caller — opens a second one. That is
      // exactly the concurrent issuance J7 declines, arriving through the
      // error path. Found at the cross-model review.
      response.body.destroy();
      // **A status is the provider not answering, not the address being
      // absent.** Recording it on the row would publish a fabricated `no_match`.
      throw providerFailed(`status ${response.statusCode}`);
    }
    return await readCapped(response.body, MAX_BYTES);
  } finally {
    // Always: a slot nobody releases stops this endpoint for the life of the
    // process, which is a worse failure than any this function can have.
    release();
  }
}

/**
 * Ask, once, with one retry after the interval.
 *
 * The retry costs a limiter slot like any other request, which is what makes
 * "retried once after the interval" true rather than approximately true. A
 * cancellation and an egress refusal are never retried: neither will succeed
 * the second time, and retrying a policy refusal is how a scanner gets a second
 * look.
 */
async function askWithRetry(
  endpoint: string,
  address: string,
  options: AskOptions,
): Promise<string | null> {
  try {
    return await askOnce(endpoint, address, options);
  } catch (first) {
    if (terminal(first)) throw first;
    try {
      return await askOnce(endpoint, address, options);
    } catch (second) {
      if (terminal(second)) throw second;
      throw asProviderFailure(second);
    }
  }
}

/**
 * The second failure, said in words that carry no endpoint.
 *
 * The outbound engine's transport failures embed the URL in their message by
 * design — every other caller wants to know what it could not reach — and this
 * is the one boundary where that must not cross, because the configured URL may
 * carry a key. Only the code travels.
 */
function asProviderFailure(error: unknown): ApiError {
  if (error instanceof ApiError && error.code === "geocoder_failed") return error;
  if (error instanceof ApiError && error.code === "remote_fetch_failed") {
    return providerFailed("unreachable");
  }
  return providerFailed("no answer");
}

/** Failures a second attempt cannot repair, and must not disguise. */
function terminal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "egress_blocked" ||
      error.code === "remote_fetch_abandoned" ||
      error.code === "geocoder_unconfigured")
  );
}

/**
 * The answer for one address: from the cache, or from the wire.
 *
 * The caller passes the address as the source holds it. Normalization decides
 * what is *asked* and what is *cached* — so two spellings of one address cost
 * one request — while the caller keeps the original for its join, which is the
 * only key the engine and this process can agree on exactly.
 */
export async function geocodeAddress(
  raw: unknown,
  options: AskOptions = {},
): Promise<RowAnswer> {
  const normalized = normalizeAddress(raw);
  // Never asked, never cached: an empty address is not a question.
  if (normalized === null) return EMPTY;

  const endpoint = configuredEndpoint();
  if (!endpoint) throw unconfiguredError();

  const cached = await readAnswer(endpoint, normalized);
  if (cached) return fromCache(cached, "cache");

  const text = await askWithRetry(endpoint, normalized, options);
  const answer = text === null ? null : readAnswerBody(text);
  if (!answer) return UNREADABLE;
  await writeAnswer(endpoint, normalized, answer);
  return fromCache(answer, "wire");
}
