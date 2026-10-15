import { isIP } from "node:net";
import { normalizeAddress } from "./ingress.mjs";

/** The identity an address-keyed allowance counts a source under. An IPv4
 * source, an IPv4-mapped one included, counts alone. An IPv6 source counts
 * with every address in its /64, the network one host is commonly given, so
 * a host cannot step around an allowance by taking a fresh address from its
 * own prefix for each request. Only accounting groups: the verified source a
 * request carries stays its full address. */
export function accountingSource(address: string): string {
  const source = normalizeAddress(address);
  if (isIP(source) !== 6) return source;
  const [head, tail] = source.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${normalizeAddress(`${groups.slice(0, 4).join(":")}::`)}/64`;
}
