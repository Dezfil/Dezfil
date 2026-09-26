import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { ApiError } from "@/lib/api/errors";
import { egressBlockedError, isAddressAllowed, validatingLookup } from "./egress";

/**
 * The outbound HTTP engine for user-directed fetches. Redirects are
 * followed manually so every hop re-enters the egress policy before it is
 * contacted; hostname admission happens inside the connect path (the
 * validating lookup), and IP literals — which Node connects to without a
 * lookup — are checked here before a request is issued.
 */

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface RemoteResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  /** Live stream — consume it or destroy it. */
  body: IncomingMessage;
  finalUrl: string;
}

export interface OpenRemoteOptions {
  method?: "GET" | "HEAD";
  /** Overall deadline for the whole exchange — redirects and body included. */
  timeoutMs?: number;
  timeoutError?: () => ApiError;
  /** Extra request headers (an identifying User-Agent, an Accept
   * override). Sent on every hop — redirects stay within the same
   * trust decision the caller made. */
  headers?: Record<string, string>;
  /**
   * Abandon the exchange when this fires.
   *
   * **The deadline is not a substitute.** Without this, a caller who no longer
   * wants an answer — a cancelled batch, a superseded search — waits out the
   * whole timeout with a socket open and the provider's quota already spent.
   * The engine had no way to be told, which is what records; a batch geocode
   * cancelled halfway would otherwise keep asking.
   */
  signal?: AbortSignal;
}

/** The exchange stopped because its caller stopped wanting it. Coded rather
 * than a bare abort, so a caller can tell it from a transport failure and not
 * report a provider as broken when it was never given a chance to answer. */
export function abandonedError(): ApiError {
  return new ApiError(
    "remote_fetch_abandoned",
    "The request was abandoned before it finished.",
    499,
  );
}

function fetchFailed(url: string, detail: string): ApiError {
  return new ApiError(
    "remote_fetch_failed",
    `Could not reach ${url}: ${detail}`,
    502,
  );
}

/** URL.hostname keeps brackets on IPv6 literals; strip for isIP/policy. */
function bareHost(parsed: URL): string {
  return parsed.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Open a remote URL under the egress policy. Rejects with the uniform
 * `egress_blocked` error before contacting a blocked destination — on the
 * first hop or any redirect hop — and with `remote_fetch_failed` for
 * network-level failures. The optional deadline covers the whole exchange:
 * when it fires mid-body, the returned stream errors with the timeout error.
 */
export async function openRemote(
  url: string,
  options: OpenRemoteOptions = {},
): Promise<RemoteResponse> {
  const method = options.method ?? "GET";
  let current = url;
  const state: {
    error: ApiError | null;
    active: { destroy: (error?: Error) => void } | null;
  } = { error: null, active: null };
  let timer: NodeJS.Timeout | null = null;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      state.error =
        options.timeoutError?.() ??
        fetchFailed(url, "the fetch exceeded its time bound");
      state.active?.destroy(state.error);
    }, options.timeoutMs);
    timer.unref();
  }
  // The caller's abandonment is the same event as the deadline's — the
  // exchange stops and the reason is coded — so it destroys the same
  // connection through the same handle, and a signal already aborted takes
  // effect before any socket opens.
  const onAbort = () => {
    state.error = state.error ?? abandonedError();
    state.active?.destroy(state.error);
  };
  if (options.signal) {
    if (options.signal.aborted) state.error = abandonedError();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  const clearDeadline = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        throw fetchFailed(url, `invalid redirect target "${current}"`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw fetchFailed(
          url,
          `redirected to unsupported scheme ${parsed.protocol}//`,
        );
      }
      const host = bareHost(parsed);
      // Node skips `lookup` for IP literals, so literals are checked here —
      // before any request exists.
      if (isIP(host) && !isAddressAllowed(host, host)) {
        throw egressBlockedError();
      }

      let response: IncomingMessage;
      try {
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          if (state.error) {
            reject(state.error);
            return;
          }
          const engine = parsed.protocol === "https:" ? https : http;
          const req = engine.request(
            parsed,
            {
              method,
              // Hostnames are admitted inside the connect path itself: a
              // name that only resolves into blocked space never opens a
              // socket, and the connected address is a validated one.
              ...(isIP(host) ? {} : { lookup: validatingLookup(host) }),
              headers: { accept: "*/*", ...options.headers },
            },
            resolve,
          );
          state.active = req;
          req.on("error", (error) => reject(state.error ?? error));
          req.end();
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw fetchFailed(
          url,
          error instanceof Error ? error.message : "network error",
        );
      }
      state.active = response;
      // A destroy-with-error must never crash the process for want of a
      // listener; real consumers attach their own handlers on top.
      response.on("error", () => {});

      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECT_STATUS.has(status) && location) {
        // A redirect may stream forever. Close it before replacing the
        // exchange's active handle; draining would leave it without an owner.
        await new Promise<void>((resolve) => {
          if (response.closed) resolve();
          else response.once("close", resolve);
          response.destroy();
        });
        if (state.error) throw state.error;
        try {
          current = new URL(location, parsed).toString();
        } catch {
          throw fetchFailed(url, `invalid redirect target "${location}"`);
        }
        continue;
      }
      // Success: the deadline keeps covering the body until the stream
      // closes — a hung transfer errors out instead of hanging the import.
      response.on("close", clearDeadline);
      return {
        statusCode: status,
        headers: response.headers,
        body: response,
        finalUrl: current,
      };
    }
    throw fetchFailed(url, `more than ${MAX_REDIRECTS} redirects`);
  } catch (error) {
    state.active?.destroy();
    clearDeadline();
    throw error;
  }
}
