/**
 * What of a service address may carry a key, and every form a key takes
 * when something repeats it.
 *
 * A refusal that would pass on a server's own words keeps them only when
 * they repeat none of these parts in any of these forms. The secrecy
 * battery searches everything the server says or keeps for the same forms,
 * so the check and the search agree on what a repeated key looks like.
 */

/** Text with its percent-escapes decoded, or as written when one is stray. */
function decoded(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/**
 * The parts of an address that may carry a key: its user, its password,
 * the pair a Basic credential encodes, its whole path and query, each query
 * value, and each path segment long enough to be one; each as written in the
 * address and as decoded. Text that is not an address is one part, whole.
 */
export function secretParts(address: string): string[] {
  let url: URL;
  try { url = new URL(address); } catch { return [address]; }
  const written = [url.username, url.password, url.pathname.length > 1 ? url.pathname : "", url.search.slice(1),
    ...url.pathname.split("/").filter(segment => segment.length >= 12)];
  // What the request sends as its credential: the user and password,
  // decoded, joined by a colon.
  const pair = url.username || url.password ? [`${decoded(url.username)}:${decoded(url.password)}`] : [];
  return [...new Set([...written, ...written.map(decoded), ...url.searchParams.values(), ...pair])]
    .filter(part => part.length >= 4);
}

/**
 * Every form a secret is looked for in: as written, percent-encoded, in
 * base64 and base64url, in hex, and in UTF-16 (its bytes one to a character,
 * as text read as Latin-1 shows them). A Basic credential is the base64 form
 * of the pair `secretParts` names.
 */
export function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [...new Set([secret, encodeURIComponent(secret), bytes.toString("base64"), bytes.toString("base64url"),
    bytes.toString("hex"), Buffer.from(secret, "utf16le").toString("latin1")])];
}

/** Whether text repeats a part of the address that may carry a key, in any
 * form a key is looked for in. */
export function repeatsAddressSecret(text: string, address: string): boolean {
  return secretParts(address).some(part => secretForms(part).some(form => text.includes(form)));
}
