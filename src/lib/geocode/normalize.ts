/**
 * How an address becomes a cache key.
 *
 * **The rule is versioned because it is part of an identity.** A cached answer
 * says *this endpoint answered this for this address*, and "this address" means
 * whatever this function returned at the time. Changing the rule without saying
 * so would mix two conventions in one cache and answer a question nobody asked.
 * The version travels in the key, so a change invalidates rather than blends.
 *
 * The rule itself is deliberately conservative: it removes differences no
 * geocoder should care about — surrounding space, repeated space, case, and
 * the several Unicode spellings of the same character — and nothing else.
 * Stripping punctuation or expanding abbreviations is the provider's job and
 * doing it here would send it something the user did not write.
 */

/** Bumped whenever `normalizeAddress` changes what it returns. */
export const NORMALIZATION_VERSION = 2;

/**
 * The form an address is cached and asked under, or `null` when there is
 * nothing to ask about.
 *
 * A row whose address is empty, blank, or absent is a different outcome from
 * one the provider could not match, so this says which by answering null rather
 * than an empty string.
 */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  // **Case folding, not lowercasing** — they are different operations and the
  // difference is visible in ordinary addresses. `toLowerCase` maps `Straße`
  // to `straße` and `STRASSE` to `strasse`, so one address written two ways
  // becomes two cache entries and two requests. Upper-then-lower is the fold
  // JavaScript actually offers: `ß` goes to `SS` on the way up and `ss` on the
  // way down, and both spellings arrive at one key. Found at the cross-model
  // review; the version above is bumped, so entries under the old rule expire
  // rather than mixing two conventions in one cache.
  return collapsed.toUpperCase().toLowerCase();
}
