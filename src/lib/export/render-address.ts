import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isAddressAllowed } from "@/lib/net/egress";

export type RenderResolver = (host: string) => Promise<string[]>;
export type RenderAddressVerdict =
  | { verdict: "allow"; addresses: string[] }
  | { verdict: "deny" | "unresolvable" };

/** Render admission is conservative: one forbidden answer refuses the whole
 * set. The connection must use these literals, never resolve the name again. */
export async function admitRenderHost(
  host: string,
  resolve: RenderResolver = async (name) =>
    (await lookup(name, { all: true, verbatim: true })).map((a) => a.address),
): Promise<RenderAddressVerdict> {
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return { verdict: "unresolvable" };
  }
  if (!addresses.length) return { verdict: "unresolvable" };
  return addresses.every((address) => isIP(address) && isAddressAllowed(host, address))
    ? { verdict: "allow", addresses }
    : { verdict: "deny" };
}
