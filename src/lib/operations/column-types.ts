/**
 * What kind of thing a column holds.
 *
 * **Pure, and importable from a client bundle**, which is why it is its own
 * module: the catalog declares that a parameter names a *text* column, and both
 * sides need the same answer — the form, so it offers the columns that can
 * work, and admission, so a caller that is not the form is refused on the same
 * terms. Two copies of these lists is how a form comes to offer a column the
 * run refuses.
 */

/** Column types an address can be read out of. Anchored and closed: an
 * unanchored match admits `VARCHAR[]`, which is a list of addresses and not an
 * address. */
const TEXT_COLUMN = /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)$/i;

/**
 * Whether a column type is a number a verb can sum.
 *
 * **Anchored, and a closed list.** An unanchored `/INT/` matches `INTERVAL` and
 * `INTEGER[]` — neither of which `sum()` takes — so a verb admitted them and the
 * engine answered a binder error, which reaches the caller as a 500 where the
 * contract promises a coded refusal. Found at cross-model review.
 */
const SCALAR_NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL(\s*\(\s*\d+\s*,\s*\d+\s*\))?|NUMERIC(\s*\(\s*\d+\s*,\s*\d+\s*\))?)$/i;

export function isTextColumn(columnType: string): boolean {
  return TEXT_COLUMN.test(columnType.trim());
}

export function isScalarNumeric(columnType: string): boolean {
  return SCALAR_NUMERIC.test(columnType.trim());
}

/** Whether a column suits a parameter that asked for one kind of column. A
 * parameter that asked for no kind takes any. */
export function suitsFieldType(
  columnType: string,
  want: "text" | "number" | undefined,
): boolean {
  if (want === undefined) return true;
  return want === "text"
    ? isTextColumn(columnType)
    : isScalarNumeric(columnType);
}
