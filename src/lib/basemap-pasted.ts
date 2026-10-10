import type { AttributionLine } from "./basemap";
import type { CustomBasemap } from "./metadata/maps";

/**
 * A pasted style's copy as a map stores it: the address, the name as typed
 * and the credit. The credit is the lines the style's sources carry, or,
 * where it carries none or was saved without being read, its host: the one
 * credit the server can vouch for. The save decides it on the server; the
 * builder draws the same copy from the check it already holds, so the map
 * shows from the click on what a reload would. Free of server imports: it
 * reaches the client bundle.
 */
export function pastedStyleCopy(url: string, name: string | null, lines: readonly AttributionLine[]): CustomBasemap {
  return { url, name, attribution: pastedStyleCredit(url, lines) };
}

/** The credit a pasted style is stored with: its own lines, else its host. */
export function pastedStyleCredit(url: string, lines: readonly AttributionLine[]): AttributionLine[] {
  return lines.length ? [...lines] : [{ label: hostOf(url) }];
}

/** An address's host; the address itself where it does not parse (the
 * save refuses such an address before it asks for a credit). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * A pasted style's save as the map read back after a lost answer would hold
 * it. The save reads the style again and stores the credit it finds, which
 * may not be the check's: the style changed since, or a style the check
 * could not read was saved anyway and the save could read it. So the read's
 * credit stands in for the copy's, and nothing else does: the address, the
 * name and the rest of the map read back must still be what was sent for the
 * save to count as landed.
 */
export function withStoredCredit(sent: Record<string, unknown>, read: { customBasemap: CustomBasemap | null }): Record<string, unknown> {
  const copy = sent.customBasemap as CustomBasemap | null | undefined;
  const stored = read.customBasemap;
  if (!copy || !stored) return sent;
  return { ...sent, customBasemap: { ...copy, attribution: stored.attribution } };
}
