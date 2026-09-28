import { describe, expect, it } from "vitest";
import { canonicalIngress, normalizeAddress, requireIngress, trustedPeers } from "./ingress.mjs";
import { preservePreloads } from "../../../scripts/preload-options.mjs";

const socket = { remoteAddress: "::ffff:127.0.0.1" };
const host = "instance.test:3391";
const forged = {
  host, "x-forwarded-for": "203.0.113.99", "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "https", "x-forwarded-port": "443",
  forwarded: 'for="203.0.113.99";host="evil.example";proto=https', "x-dezfil-ingress": "forged",
};

describe("socket provenance", () => {
  it("discards every forwarding field from an untrusted peer", () => {
    expect(canonicalIngress({ socket, headers: forged })).toEqual({
      peer: "127.0.0.1", source: "127.0.0.1", origin: "http://instance.test:3391",
      host, scheme: "http", port: "3391", secure: false,
    });
    expect(canonicalIngress({ socket: { ...socket, encrypted: true }, headers: forged }).secure).toBe(true);
  });

  it("separates direct IPv6 from an explicitly trusted IPv4 proxy socket", () => {
    const trusted = trustedPeers("127.0.0.1");
    expect(canonicalIngress({ socket, headers: forged }, trusted)).toMatchObject({
      source: "203.0.113.99", origin: "https://evil.example", secure: true,
    });
    expect(canonicalIngress({ socket: { remoteAddress: "::1" }, headers: forged }, trusted)).toMatchObject({
      source: "::1", origin: `http://${host}`, secure: false,
    });
  });

  it("reduces source chains at the nearest untrusted hop and drops injected host/proto/port prefixes", () => {
    const headers = { host,
      "x-forwarded-for": "203.0.113.99, 192.0.2.8, 10.0.0.2",
      "x-forwarded-host": "evil.example, maps.example:8443",
      "x-forwarded-proto": "http, https", "x-forwarded-port": "80, 8443" };
    expect(canonicalIngress({ socket, headers }, trustedPeers("127.0.0.1, 10.0.0.0/8"))).toMatchObject({
      source: "192.0.2.8", origin: "https://maps.example:8443", port: "8443", secure: true,
    });
  });

  it("supports canonical Forwarded with IPv6 and normalizes equivalent address spellings", () => {
    expect(normalizeAddress("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeAddress("[2001:0db8:0:0::1]:12345")).toBe("2001:db8::1");
    const headers = { host, forwarded: 'for="[2001:db8::1]:12345";proto=https;host="maps.example"' };
    expect(canonicalIngress({ socket, headers }, trustedPeers("127.0.0.1"))).toMatchObject({
      source: "2001:db8::1", origin: "https://maps.example", port: "443",
    });
    expect(trustedPeers("2001:db8::/32")("2001:db8::1")).toBe(true);
  });

  it.each([
    { "x-forwarded-for": "unknown" },
    { "x-forwarded-proto": "javascript" },
    { "x-forwarded-host": "user@maps.example" },
    { "x-forwarded-host": "maps.example/path" },
    { "x-forwarded-port": "65536" },
    { "x-forwarded-host": "maps.example:80", "x-forwarded-port": "443" },
    { "x-forwarded-for": "192.0.2.1", forwarded: "for=192.0.2.2" },
    { "x-forwarded-proto": "http", forwarded: "for=192.0.2.1;proto=https" },
    { "x-forwarded-host": "maps.example", forwarded: "for=192.0.2.1;host=other.example" },
  ])("refuses malformed or conflicting trusted forwarding: %j", headers => {
    expect(() => canonicalIngress({ socket, headers: { host, ...headers } }, trustedPeers("127.0.0.1"))).toThrow();
  });

  it("does not accept a submitted provenance stamp or a claim of proxy trust", () => {
    expect(() => requireIngress(new Headers({ "x-dezfil-ingress": "forged", "x-trusted-proxy": "true" }))).toThrow();
    expect(canonicalIngress({ socket, headers: { ...forged, "x-trusted-proxy": "true" } }).source).toBe("127.0.0.1");
    expect(() => trustedPeers("not-an-address")).toThrow();
    expect(() => trustedPeers("127.0.0.1/99")).toThrow();
  });
});

describe("development preload composition", () => {
  it("preserves multiple observers through Next's single import option and remains idempotent", () => {
    const own = "file:///application/scripts/ingress-preload.mjs";
    const composed = preservePreloads('--trace-warnings --import=./first.mjs --import "./second observer.mjs"', own);
    expect(composed).toContain("--trace-warnings");
    expect(composed.match(/--import=/g)).toHaveLength(1);
    const code = Buffer.from(composed.split("base64,")[1], "base64").toString("utf8");
    expect(code).toContain("/first.mjs");
    expect(code).toContain("/second%20observer.mjs");
    expect(code).toContain(own);
    expect(preservePreloads(composed, own)).toBe(composed);
  });
});
