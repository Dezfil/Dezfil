/**
 * The one substring matcher: case-insensitive over Unicode text, shared
 * verbatim by the builder's instant layer-name filtering and the
 * endpoint's layer answers — one semantics on both sides, so immediate
 * and server results reconcile instead of disagreeing. Browser-safe: no
 * server imports.
 */

/** Case-fold for matching, approximating full Unicode case folding
 * with what the platform gives us: the upper-then-lower round trip
 * folds "ß"/"Straße" to "ss"/"strasse" (simple lowercase leaves "ß"
 * unequal to "SS"), and stripping the combining dot above after NFD
 * settles the Turkish "İ" against plain "i". Locale-independent. */
export function foldCase(text: string): string {
  return text
    .toUpperCase()
    .toLowerCase()
    .normalize("NFD")
    .replace(/̇/g, "")
    .normalize("NFC");
}

/** Does `haystack` contain `needle`, case-insensitively? An empty
 * needle matches nothing — an empty query answers no rows, not all. */
export function matches(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return foldCase(haystack).includes(foldCase(needle));
}
