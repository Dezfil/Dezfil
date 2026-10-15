import { isIP } from "node:net";
import { normalizeAddress } from "./ingress.mjs";

/** The identity an address-keyed allowance counts a source under. An IPv4
 * source, an IPv4-mapped one included, counts alone. So does a source in
 * the NAT64 well-known prefix, 64:ff9b::/96, which carries its IPv4 client
 * in its last 32 bits: it counts as that client, so the clients behind one
 * translator keep separate allowances and each shares its own with its
 * direct IPv4 address. The local-use prefix 64:ff9b:1::/48 is left alone:
 * a network may place the IPv4 client at any of several prefix lengths
 * inside it, so the address does not say which bits are the client. An
 * IPv6 source counts with every address in its /64, the network one host
 * is commonly given, so a host cannot step around an allowance by taking a
 * fresh address from its own prefix for each request. Only accounting
 * groups: the verified source a request carries stays its full address. */
export function accountingSource(address: string): string {
  const source = normalizeAddress(address);
  if (isIP(source) !== 6) return source;
  const [head, tail] = source.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const value = groups.map((group) => Number.parseInt(group, 16));
  if (value[0] === 0x64 && value[1] === 0xff9b && value.slice(2, 6).every((group) => group === 0)) {
    return [value[6] >> 8, value[6] & 255, value[7] >> 8, value[7] & 255].join(".");
  }
  return `${normalizeAddress(`${groups.slice(0, 4).join(":")}::`)}/64`;
}
