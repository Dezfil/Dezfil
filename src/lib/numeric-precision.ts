/**
 * The numeric filter's one rule for how finely a slider moves and how many
 * decimals its bounds show.
 *
 * Before this, the brush stepped by a two-hundredth of the extent — an
 * arbitrary fraction — and the bound was trimmed to six significant digits
 * on the way to storage, so a filter over a mileage column surfaced bounds
 * like `12.3457` and `0.0142857`. Step and display disagreed, and neither
 * had anything to do with the column.
 *
 * Step and decimals are derived together, so every position the slider can
 * reach is a number the readout renders exactly: no float tails, and never
 * two adjacent positions showing the same value.
 *
 * Scope is deliberate. This is the numeric filter's rule. The same roughness
 * exists in legend breaks, widget values and the hex-bin distance controls;
 * adopting it there is a follow-up, not an import away.
 */

/** DuckDB's integer column types — the same family the fields API reports. */
const INTEGER_TYPE = /^U?(TINY|SMALL|BIG|HUGE)?INT/i;

/** Whether a column's declared type only ever holds whole numbers.
 *
 *  Read from the declared type, never guessed from the extent: a column of
 *  1, 2.5 and 4 has whole endpoints and fractional data, and stepping it by
 *  1 would put 2.5 out of reach. The filter already reads this type to badge
 *  a field `int` or `float`. */
export function isIntegerColumn(columnType: string | undefined): boolean {
  return columnType !== undefined && INTEGER_TYPE.test(columnType.trim());
}

/** How many positions a brush offers across its extent, at most. The step
 *  rounds down to a readable increment, so the real count is usually more. */
const TARGET_STEPS = 200;

/**
 * The step for an extent: the largest readable increment — 1, 2 or 5 times
 * a power of ten — no greater than a two-hundredth of the span.
 *
 * An integer column never steps below 1.
 */
export function stepFor(
  min: number,
  max: number,
  columnType?: string,
): number {
  const span = Math.abs(max - min);
  const whole = isIntegerColumn(columnType);
  if (!Number.isFinite(span) || span <= 0) return whole ? 1 : 1;
  const rough = span / TARGET_STEPS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const scaled = rough / magnitude;
  // The largest of 1/2/5 that still fits inside the rough step.
  const nice = scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1;
  const step = nice * magnitude;
  return whole ? Math.max(1, Math.round(step)) : step;
}

/**
 * The decimals a step needs to render exactly — and therefore the decimals
 * every reachable position needs.
 *
 * Bounded by what a double can distinguish rather than by an arbitrary cap:
 * a cap would let two adjacent positions print the same number, which is
 * the one thing this rule exists to prevent.
 */
export function decimalsFor(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (Number.isInteger(step)) return 0;
  // toExponential carries the value's own precision, so this reads the
  // decimals off the number rather than off a printed approximation.
  const [mantissa, exponent] = step.toExponential().split("e");
  const fractionDigits = (mantissa.split(".")[1] ?? "").length;
  // Bounded by what `toFixed` accepts, not by taste: a lower cap would let
  // two adjacent positions of a very small extent print the same number,
  // which is the one thing this rule exists to prevent.
  return Math.min(100, Math.max(0, fractionDigits - Number(exponent)));
}

/** Step and decimals for a field, together — the pair every consumer uses. */
export interface Resolution {
  step: number;
  decimals: number;
}

export function resolutionFor(
  min: number,
  max: number,
  columnType?: string,
): Resolution {
  const step = stepFor(min, max, columnType);
  return { step, decimals: decimalsFor(step) };
}

/**
 * A slider position as the one number every consumer sees: snapped to the
 * step and rounded to the decimals that step needs.
 *
 * One rounding, once — the readout, both live map previews and the stored
 * filter all take this value, so what is shown cannot drift from what is
 * filtered. (They used to disagree: the GPU channel received the raw
 * position while the query channel received a six-significant-digit trim.)
 */
export function snap(value: number, { step, decimals }: Resolution): number {
  if (!Number.isFinite(value)) return value;
  const snapped = Math.round(value / step) * step;
  // Snapping in binary floating point reintroduces the tail it removes
  // (0.1 * 3 = 0.30000000000000004); the decimals the step needs are
  // exactly enough to spend it.
  return Number(snapped.toFixed(decimals));
}

/** A bound as text, at the field's own resolution. */
export function formatBound(value: number, { decimals }: Resolution): string {
  if (!Number.isFinite(value)) return "";
  // toFixed renders -0 as "-0"; the extent's own zero is not negative.
  const fixed = value.toFixed(decimals);
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
}

/**
 * A bound as text that always reads back as the number itself.
 *
 * The field's resolution governs values the slider produces, and it renders
 * those exactly. It must not govern a value the user typed at finer
 * precision, or an extent endpoint that happens to sit off the lattice —
 * formatting those at the derived decimals would print a number that is not
 * the one being filtered, which is exactly what "what is shown is what is
 * filtered" forbids. So the derived form is used only when it round-trips.
 */
export function exactText(value: number, res: Resolution): string {
  if (!Number.isFinite(value)) return "";
  const derived = formatBound(value, res);
  return Number(derived) === value ? derived : String(value);
}
