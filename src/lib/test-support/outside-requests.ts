import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { afterEach, beforeEach, expect } from "vitest";

/**
 * Keeps a test file's requests on this machine.
 *
 * A test of a service road runs against loopback fixtures, but a defect in
 * the road (or one seeded on purpose to prove a test can fail) may send the
 * request to the service's public default instead: the public Overpass
 * server, Amazon's S3 addresses. Without a guard that request leaves the
 * machine and the test finds out afterwards, if at all.
 *
 * The guard wraps the outbound engine's two transports (node's http and
 * https, request and get alike) and the platform's fetch. A request whose
 * destination is not this machine is refused before a socket or a real name
 * lookup exists, and recorded by scheme and host only (never a path, a
 * query or user information, which may hold a seeded key). The test that
 * made it fails at its end, even when the code under test turned the
 * refusal into a refusal of its own.
 *
 * What may pass: a loopback literal (127.0.0.0/8, ::1) and `localhost`.
 * A name reserved for tests (`.test`, `.example`, `.invalid`, `.localhost`)
 * may pass through the engine's own lookup, the one a test answers with a
 * fixture resolver, and is let through only when every address it answers
 * is loopback; the engine's egress policy refuses the rest first. Any other
 * name is refused before it is looked up.
 */

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
type LookupFunction = (hostname: string, options: object, callback: LookupCallback) => void;

const RESERVED_FOR_TESTS = /(^|\.)(test|example|invalid|localhost)$/;

/** Is this host this machine: a loopback literal or `localhost`? */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  return isIP(bare) === 4 && bare.startsWith("127.");
}

function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

function refusal(origin: string): Error {
  return Object.assign(new Error(`Refused by the test guard: ${origin} is not on this machine.`), { code: "ETESTOUTSIDE" });
}

export interface OutsideRequestGuard {
  /** Each refused destination, as scheme and host. */
  readonly attempts: readonly string[];
  /** Put the transports and fetch back as they were when the guard went in. */
  restore(): void;
}

/** Wrap the transports and fetch now; `restore` undoes it. */
export function guardOutsideRequests(): OutsideRequestGuard {
  const attempts: string[] = [];
  const originals = {
    httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get,
    fetch: globalThis.fetch,
  };

  /** The request's arguments with its lookup wrapped, or a refusal. */
  function admit(args: unknown[], protocol: string): unknown[] | Error {
    const first = args[0];
    const fromUrl = typeof first === "string" || first instanceof URL;
    const url = fromUrl ? new URL(String(first)) : null;
    const optionsAt = fromUrl ? (args[1] && typeof args[1] === "object" ? 1 : -1) : 0;
    const options = (optionsAt >= 0 ? args[optionsAt] : {}) as { hostname?: string; host?: string; protocol?: string; lookup?: LookupFunction };
    const host = bareHost(url?.hostname ?? options.hostname ?? options.host ?? "localhost");
    const origin = `${url?.protocol ?? options.protocol ?? protocol}//${host}`;
    if (isLoopbackHost(host)) return args;
    const refuse = () => { attempts.push(origin); return refusal(origin); };
    // A literal elsewhere, a public name, or a test name with no engine
    // lookup to answer it (the platform's would ask the real resolver).
    if (isIP(host) || !RESERVED_FOR_TESTS.test(host) || typeof options.lookup !== "function") return refuse();
    const inner = options.lookup;
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => inner(hostname, lookupOptions, (error, address, family) => {
      if (error) { callback(error, address, family); return; }
      const answered = Array.isArray(address) ? address.map(entry => entry.address) : [address];
      if (answered.every(isLoopbackHost)) callback(null, address, family);
      else callback(refuse() as NodeJS.ErrnoException, "");
    });
    const wrapped = [...args];
    wrapped[optionsAt] = { ...options, lookup };
    return wrapped;
  }

  function guarded<T extends (...args: never[]) => unknown>(original: T, protocol: string): T {
    return ((...args: unknown[]) => {
      const admitted = admit(args, protocol);
      if (admitted instanceof Error) throw admitted;
      return (original as unknown as (...a: unknown[]) => unknown)(...admitted);
    }) as unknown as T;
  }

  http.request = guarded(originals.httpRequest, "http:");
  http.get = guarded(originals.httpGet, "http:");
  https.request = guarded(originals.httpsRequest, "https:");
  https.get = guarded(originals.httpsGet, "https:");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = bareHost(url.hostname);
    if (!isLoopbackHost(host)) {
      const origin = `${url.protocol}//${host}`;
      attempts.push(origin);
      throw refusal(origin);
    }
    return originals.fetch(input, init);
  }) as typeof fetch;

  return {
    attempts,
    restore() {
      http.request = originals.httpRequest; http.get = originals.httpGet;
      https.request = originals.httpsRequest; https.get = originals.httpsGet;
      globalThis.fetch = originals.fetch;
    },
  };
}

/**
 * The guard around every test of the file that calls this (at its top, so
 * it goes in before the file's own hooks): a test that sent a request
 * anywhere but this machine fails, naming where.
 */
export function keepRequestsOnThisMachine(): void {
  let guard: OutsideRequestGuard | null = null;
  beforeEach(() => { guard = guardOutsideRequests(); });
  afterEach(() => {
    const attempts = [...(guard?.attempts ?? [])];
    guard?.restore();
    guard = null;
    expect(attempts, "requests a test tried to send off this machine").toEqual([]);
  });
}
