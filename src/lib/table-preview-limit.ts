/** Shared first-row bound for dataset inspection and geometry row outcomes. */
export const INSPECT_PREVIEW_ROWS = 50;

/** Characters a preview cell shows of a longer text or WKT value. */
export const PREVIEW_EXCERPT_CHARACTERS = 512;

/** A preview cell's SQL: a value longer than the excerpt keeps its first
 * characters and ends in an ellipsis. Stored data is never changed. */
export const previewExcerpt = (value: string) =>
  `CASE WHEN length(${value}) > ${PREVIEW_EXCERPT_CHARACTERS} THEN left(${value}, ${PREVIEW_EXCERPT_CHARACTERS}) || '…' ELSE ${value} END`;
