import { lookup as nodeLookup } from "node:dns/promises";
import type {
  LookupAddress,
  LookupOptions as DnsLookupOptions,
} from "node:dns";
import { isIP } from "node:net";
import { ApiError } from "@/lib/api/errors";

/**
 * Egress policy: the server does not contact loopback, private, link-local,
 * or metadata address space on a user's behalf, by default. One module
 * serves every door — URL import, refresh, and the PostGIS connect/test
 * endpoints — and validation binds to the address actually connected, not to
 * a separate earlier resolution, so the answer cannot change between check
 * and connect.
 *
 * The rejection is one static error, emitted before any connection attempt
 * and byte-identical whether or not anything listens at the blocked address:
 * the policy must never become a scanner oracle.
 */

/** One message for every blocked destination — never varied, never detailed. */
const BLOCKED_MESSAGE =
  "The requested address is not reachable from this server: loopback, " +
  "private-network, link-local, and metadata addresses are blocked by " +
  "default. Specific hosts can be allowed with " +
  "DEZFIL_EGRESS_ALLOWLIST.";

export function egressBlockedError(): ApiError {
  return new ApiError("egress_blocked", BLOCKED_MESSAGE, 403);
}

/** Parse an IP into bytes (4 or 16). Returns null when not an IP. */
function parseIp(text: string): Uint8Array | null {
  const version = isIP(text);
  if (version === 4) {
    const parts = text.split(".").map(Number);
    return Uint8Array.from(parts);
  }
  if (version === 6) {
    // Expand :: and any trailing dotted-quad into 16 bytes.
    let body = text;
    let v4Tail: number[] = [];
    const dotted = body.match(/:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
      v4Tail = dotted[1].split(".").map(Number);
      body = body.slice(0, -dotted[1].length) + "0:0";
    }
    const halves = body.split("::");
    const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
    const tail =
      halves.length > 1 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
    const missing = 8 - head.length - tail.length;
    const groups = [
      ...head,
      ...Array(halves.length > 1 ? Math.max(missing, 0) : 0).fill("0"),
      ...tail,
    ];
    if (groups.length !== 8) return null;
    const bytes = new Uint8Array(16);
    groups.forEach((g, i) => {
      const n = parseInt(g, 16);
      bytes[2 * i] = n >> 8;
      bytes[2 * i + 1] = n & 0xff;
    });
    if (v4Tail.length === 4) bytes.set(v4Tail, 12);
    return bytes;
  }
  return null;
}

/** IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) collapse to their
 * embedded IPv4 address before classification — a mapped loopback is still
 * loopback. */
function unmap(addr: Uint8Array): Uint8Array {
  if (addr.length !== 16) return addr;
  const mapped =
    addr.slice(0, 10).every((b) => b === 0) && addr[10] === 0xff && addr[11] === 0xff;
  const nat64 =
    addr[0] === 0x00 &&
    addr[1] === 0x64 &&
    addr[2] === 0xff &&
    addr[3] === 0x9b &&
    addr.slice(4, 12).every((b) => b === 0);
  return mapped || nat64 ? addr.slice(12) : addr;
}

function cidr(text: string): { base: Uint8Array; bits: number } | null {
  const [ip, bitsRaw] = text.split("/");
  const base = parseIp(ip);
  if (!base) return null;
  const bits =
    bitsRaw === undefined ? base.length * 8 : Number.parseInt(bitsRaw, 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > base.length * 8) return null;
  return { base, bits };
}

function inCidr(addr: Uint8Array, base: Uint8Array, bits: number): boolean {
  if (addr.length !== base.length) return false;
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i++) if (addr[i] !== base[i]) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = 0xff << (8 - rest);
  return (addr[whole] & mask) === (base[whole] & mask);
}

const BLOCKED_RANGES = [
  // IPv4
  "0.0.0.0/8", // unspecified / "this network"
  "10.0.0.0/8", // private
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, including cloud metadata
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, broadcast
  // IPv6
  "::/128", // unspecified
  "::1/128", // loopback
  "fc00::/7", // unique-local
  "fe80::/10", // link-local
  "ff00::/8", // multicast
].flatMap((c) => {
  const parsed = cidr(c);
  return parsed ? [parsed] : [];
});

/** Is this IP inside blocked address space? (Mapped forms are unwrapped.) */
export function isBlockedIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true; // unparseable is not connectable
  const addr = unmap(parsed);
  return BLOCKED_RANGES.some(({ base, bits }) => inCidr(addr, base, bits));
}

/** Administrator allowlist: comma-separated hostnames, IPs, or CIDRs. */
function allowlist(): string[] {
  return (process.env.DEZFIL_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A hostname the administrator allowed by name skips address checks entirely. */
export function isAllowlistedHost(host: string): boolean {
  const needle = host.toLowerCase();
  return allowlist().some((entry) => entry.toLowerCase() === needle);
}

function isAllowlistedIp(ip: string): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  return allowlist().some((entry) => {
    const range = cidr(entry);
    return range !== null && inCidr(addr, range.base, range.bits);
  });
}

/** May the server connect to this address (requested as `host`)? */
export function isAddressAllowed(host: string, ip: string): boolean {
  if (!isBlockedIp(ip)) return true;
  return isAllowlistedHost(host) || isAllowlistedIp(ip);
}

type LookupFn = typeof nodeLookup;

/**
 * Resolve a host and return only the addresses the policy admits. Rejects
 * with the uniform blocked error when nothing survives — before anything is
 * contacted. IP literals never resolve; they are checked directly.
 */
export async function resolveAllowed(
  host: string,
  lookupFn: LookupFn = nodeLookup,
): Promise<string[]> {
  // URI hosts retain brackets in storage. Only valid IPv6 literals lose
  // them here, before both classification and allowlist name matching.
  if (host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6) {
    host = host.slice(1, -1);
  }
  if (isIP(host)) {
    if (!isAddressAllowed(host, host)) throw egressBlockedError();
    return [host];
  }
  const results = await lookupFn(host, { all: true, verbatim: true });
  const admitted = results
    .map((r) => r.address)
    .filter((address) => isAddressAllowed(host, address));
  if (admitted.length === 0) throw egressBlockedError();
  return admitted;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup`-compatible function for `http.request` that admits only
 * policy-approved addresses — validation happens inside the connect path
 * itself, so the connected address is by construction a validated one (the
 * check-to-connect gap of a separate pre-resolution never opens). Node
 * bypasses `lookup` for IP literals, so literals must be checked by the
 * caller before the request is issued.
 */
export function validatingLookup(host: string) {
  return (
    hostname: string,
    options: DnsLookupOptions | number,
    callback: LookupCallback,
  ): void => {
    const opts: DnsLookupOptions =
      typeof options === "number" ? { family: options } : (options ?? {});
    const wanted =
      opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : opts.family;
    nodeLookup(hostname, { all: true, verbatim: true })
      .then((results) => {
        const admitted = results.filter(
          (r) =>
            isAddressAllowed(host, r.address) &&
            (!wanted || r.family === wanted),
        );
        if (admitted.length === 0) {
          callback(egressBlockedError(), "");
          return;
        }
        if (opts.all) {
          callback(null, admitted);
        } else {
          callback(null, admitted[0].address, admitted[0].family);
        }
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, ""));
  };
}
