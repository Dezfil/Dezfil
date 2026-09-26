/**
 * Table names are derived from filenames, sanitized to valid SQL
 * identifiers, and deduplicated on collision — never a silent overwrite
 * (spec: Upload).
 */

export function deriveTableName(
  originalFilename: string,
  taken: ReadonlySet<string>,
): string {
  const stem = originalFilename
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(?=[0-9])/, "t");
  const base = stem || "table";

  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
