/**
 * Every form a key takes when something repeats it.
 *
 * The secrecy battery searches everything the server says or keeps for each
 * key it set in a service address, in each of these forms.
 */

/**
 * Every form a secret is looked for in: as written, percent-encoded, in
 * base64 and base64url, in hex, and in UTF-16 (its bytes one to a character,
 * as text read as Latin-1 shows them). A Basic credential is the base64 form
 * of the pair of a user and a password joined by a colon.
 */
export function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [...new Set([secret, encodeURIComponent(secret), bytes.toString("base64"), bytes.toString("base64url"),
    bytes.toString("hex"), Buffer.from(secret, "utf16le").toString("latin1")])];
}
