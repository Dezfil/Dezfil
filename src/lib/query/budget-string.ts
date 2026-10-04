/** JSON string bytes without materializing an escaped JSON string in the
 * engine. The match lists contain only escape characters; plain wide text
 * retains the engine's original storage under small engine memory budgets. */
export function stringByteLength(text: string): string {
  return String.raw`(octet_length(encode(${text})) + 2
    + len(regexp_extract_all(${text}, '["\\\x08\x09\x0a\x0c\x0d]'))
    + 5 * len(regexp_extract_all(${text}, '[\x00-\x07\x0b\x0e-\x1f]')))`;
}
