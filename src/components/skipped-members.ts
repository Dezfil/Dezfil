/**
 * Skipped container members: the import answer names every member the
 * format's reader enumerated but did not import, with its reason. The
 * notice pairs each member with that reason — visibility only; the
 * answer itself is unchanged.
 */

export interface SkippedMember {
  layer: string;
  reason: string;
}

/** A skip with the file it came from: a batch's skips
 * from several files must stay simultaneously attributable. */
export interface AttributedSkip extends SkippedMember {
  source: string;
}

export function skippedNotice(skipped: SkippedMember[]): string {
  const members = skipped
    .map((s) => `${s.layer} (${s.reason})`)
    .join(", ");
  return skipped.length === 1
    ? `Skipped 1 member: ${members}`
    : `Skipped ${skipped.length} members: ${members}`;
}

/** The batch form: each member named under its source file,
 * so two files' skips never blur together. */
export function attributedSkippedNotice(skipped: AttributedSkip[]): string {
  const members = skipped
    .map((s) => `${s.source}: ${s.layer} (${s.reason})`)
    .join(", ");
  return skipped.length === 1
    ? `Skipped 1 member: ${members}`
    : `Skipped ${skipped.length} members: ${members}`;
}

/** The builder's whisper is last-wins, so each created table's notice
 * carries the import's skips with it instead of erasing them. The two
 * read as two sentences: a notice that already ends one gets no second
 * stop, and an empty one leaves the skips alone. */
export function withSkips(
  text: string,
  skipped: SkippedMember[] | null,
): string {
  if (!skipped?.length) return text;
  if (text === "") return skippedNotice(skipped);
  return `${text}${/[.!?]$/.test(text) ? "" : "."} ${skippedNotice(skipped)}`;
}
