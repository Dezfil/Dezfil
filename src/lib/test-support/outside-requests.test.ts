import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered here, as the egress tests answer it.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import http, { createServer, type Server } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { openRemote } from "@/lib/net/remote-fetch";
import { guardOutsideRequests, isLoopbackHost, type OutsideRequestGuard } from "./outside-requests";

/**
 * The guard a service-road test file wears: a request to anything but this
 * machine is refused before the transport sees it, and recorded by scheme
 * and host. What passes is loopback, and a test-reserved name whose fixture
 * resolver answers loopback.
 */
const SEED = "SEEDED-KEY-0001-QUERY";

let server: Server;
let base: string;
let reached: string[];
let transports: { request: typeof http.request; get: typeof http.get; secure: typeof https.request; fetch: typeof fetch };
let spies: { http: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; https: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> };
let guard: OutsideRequestGuard;

/** The transports under the guard. They pass on only what this file's own
 * fixtures serve, so a guard that failed open makes a test fail here rather
 * than send anything off this machine. */
function underneath(real: (...args: never[]) => unknown) {
  return vi.fn((...args: unknown[]) => {
    const [first] = args;
    const target = first instanceof Request ? first.url : first instanceof URL || typeof first === "string" ? String(first) : null;
    const host = target ? new URL(target).hostname : (first as { hostname?: string }).hostname;
    const options = (target ? args[1] : first) as { lookup?: unknown } | undefined;
    // The test name only with the engine's lookup, which this file answers.
    const named = host === "fixture.test" && typeof options?.lookup === "function";
    if (host !== "127.0.0.1" && !named) throw new Error("reached the transport under the guard");
    return (real as (...a: unknown[]) => unknown)(...args);
  });
}

beforeEach(async () => {
  reached = [];
  server = createServer((req, res) => { reached.push(req.url ?? ""); res.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1,fixture.test");
  dns.lookup.mockReset();
  // Spies under the guard: what the guard lets through reaches them.
  transports = { request: http.request, get: http.get, secure: https.request, fetch: globalThis.fetch };
  spies = { http: underneath(transports.request), get: underneath(transports.get), https: underneath(transports.secure), fetch: underneath(transports.fetch) };
  http.request = spies.http as unknown as typeof http.request;
  http.get = spies.get as unknown as typeof http.get;
  https.request = spies.https as unknown as typeof https.request;
  globalThis.fetch = spies.fetch as unknown as typeof fetch;
  guard = guardOutsideRequests();
});

afterEach(async () => {
  guard.restore();
  http.request = transports.request; http.get = transports.get; https.request = transports.secure; globalThis.fetch = transports.fetch;
  vi.unstubAllEnvs();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("what counts as this machine", () => {
  it.each([
    ["127.0.0.1", true], ["127.8.9.10", true], ["::1", true], ["[::1]", true], ["localhost", true], ["LOCALHOST", true],
    ["10.0.0.5", false], ["203.0.113.10", false], ["::ffff:8.8.8.8", false], ["overpass-api.de", false],
    ["bucket.s3.amazonaws.com", false], ["fixture.test", false], ["127.0.0.1.example.com", false],
  ])("%s is loopback: %s", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});

describe("a request off this machine", () => {
  it.each([
    ["the public Overpass server", `https://overpass-api.de/api/interpreter?key=${SEED}`, "https://overpass-api.de"],
    ["an Amazon S3 address", `https://bucket.s3.amazonaws.com/dir/points.csv?key=${SEED}`, "https://bucket.s3.amazonaws.com"],
    ["a public literal", `http://203.0.113.10/data?key=${SEED}`, "http://203.0.113.10"],
  ] as const)("is refused before the engine's transport sees it: %s", async (_name, url, origin) => {
    await expect(openRemote(url)).rejects.toMatchObject({ code: "remote_fetch_failed" });
    expect(spies.http).not.toHaveBeenCalled();
    expect(spies.https).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(guard.attempts).toEqual([origin]);
  });

  it("is refused before the platform's fetch sees it", async () => {
    await expect(fetch(`https://overpass-api.de/api/interpreter?key=${SEED}`, { method: "POST", body: "data=x" }))
      .rejects.toThrow("Refused by the test guard: https://overpass-api.de is not on this machine.");
    await expect(fetch(new Request("https://bucket.s3.amazonaws.com/"))).rejects.toThrow("Refused by the test guard");
    expect(spies.fetch).not.toHaveBeenCalled();
    expect(guard.attempts).toEqual(["https://overpass-api.de", "https://bucket.s3.amazonaws.com"]);
  });

  it("is refused by name before any lookup when the caller brings no lookup of its own", () => {
    expect(() => http.get("http://fixture.test/data")).toThrow("Refused by the test guard: http://fixture.test is not on this machine.");
    expect(() => https.request({ hostname: "overpass-api.de", path: "/api/interpreter" })).toThrow("Refused by the test guard");
    expect(spies.get).not.toHaveBeenCalled();
    expect(spies.https).not.toHaveBeenCalled();
    expect(guard.attempts).toEqual(["http://fixture.test", "https://overpass-api.de"]);
  });

  it("is refused when a test name's resolver answers anything but loopback", async () => {
    // The unspecified address stands for anywhere else: were it let
    // through, the connection would land on this machine's own fixture.
    dns.lookup.mockResolvedValue([{ address: "0.0.0.0", family: 4 }]);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "fixture.test");
    await expect(openRemote(`http://fixture.test:${new URL(base).port}/data?key=${SEED}`)).rejects
      .toThrow("Refused by the test guard: http://fixture.test is not on this machine.");
    expect(reached).toEqual([]);
    expect(guard.attempts).toEqual(["http://fixture.test"]);
  });

  it("never records more of an address than scheme and host", async () => {
    await openRemote(`https://SEEDED-KEY-0001-USER:pass@overpass-api.de/SEEDED-KEY-0001-PATH?key=${SEED}`).catch(() => {});
    await fetch(`https://SEEDED-KEY-0001-USER:pass@bucket.s3.amazonaws.com/SEEDED-KEY-0001-PATH?key=${SEED}`).catch(() => {});
    expect(guard.attempts).toEqual(["https://overpass-api.de", "https://bucket.s3.amazonaws.com"]);
    expect(JSON.stringify(guard.attempts)).not.toContain("SEEDED-KEY");
  });
});

describe("a request on this machine", () => {
  it("passes to a loopback fixture through the engine and through fetch", async () => {
    const response = await openRemote(`${base}/engine`);
    response.body.resume();
    await new Promise(resolve => response.body.once("close", resolve));
    expect(await (await fetch(`${base}/fetch`)).text()).toBe("ok");
    expect(reached).toEqual(["/engine", "/fetch"]);
    expect(guard.attempts).toEqual([]);
  });

  it("passes for a test name the engine's resolver answers with loopback", async () => {
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const response = await openRemote(`http://fixture.test:${new URL(base).port}/named`);
    response.body.resume();
    await new Promise(resolve => response.body.once("close", resolve));
    expect(reached).toEqual(["/named"]);
    expect(guard.attempts).toEqual([]);
  });
});

it("puts the transports and fetch back as they were", () => {
  guard.restore();
  const under = { request: http.request, get: http.get, secure: https.request, fetch: globalThis.fetch };
  expect(under.request).toBe(http.request);
  const wearing = guardOutsideRequests();
  for (const [name, now] of [["request", http.request], ["get", http.get], ["secure", https.request], ["fetch", globalThis.fetch]] as const) {
    expect(now, name).not.toBe(under[name]);
  }
  wearing.restore();
  expect([http.request, http.get, https.request, globalThis.fetch]).toEqual([under.request, under.get, under.secure, under.fetch]);
  guard = guardOutsideRequests();
});
