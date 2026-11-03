import type { QuantileFill } from "./style";

/**
 * A class boundary as text: every digit its value needs and no more, so
 * stored equals shown and two different boundaries never read alike.
 * Thousands are grouped; micro magnitudes read in exponent form. The text
 * is enterable as-is: strip the commas and it parses back to the same
 * number.
 */
export function formatBreak(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  // Without an argument, the exponent form carries as many digits as the
  // value needs to be told from its neighbours.
  if (abs > 0 && abs < 1e-4) return n.toExponential();
  // The shortest text that reads back as this exact number.
  const shortest = String(n);
  if (shortest.includes("e")) return shortest;
  const negative = shortest.startsWith("-");
  const [whole, fraction] = (negative ? shortest.slice(1) : shortest).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** One class's automatic text, and how the Style panel splits it around
 * the class's upper boundary. */
export interface ClassLabel {
  /** What the class holds, as the legend reads it. */
  text: string;
  /** The text before the class's upper boundary, where the panel puts
   * that boundary's input ("≤", "1 –"; empty when the boundary alone names
   * the class). Absent on the last class, which has no upper boundary. */
  lead?: string;
}

/** Whether a paint's classes can be named by the whole numbers they hold:
 * the classified result is a whole-number type, every break is a whole
 * number, and each is small enough that the next whole number is exact. */
function countsByOne(paint: Pick<QuantileFill, "breaks" | "wholeNumbers">): boolean {
  return (
    paint.wholeNumbers === true &&
    paint.breaks.every((b) => Number.isSafeInteger(b) && Number.isSafeInteger(b + 1))
  );
}

/**
 * The automatic class texts of a classed paint, low to high. A value equal
 * to a break belongs to the lower class, as the map's colouring places it,
 * so the first class reads "≤ b" and the last "> b". On whole numbers each
 * class between names exactly the whole numbers it holds: one as that
 * number ("2"), several as a range ("5 – 14"). Otherwise the classes
 * between name the boundaries they share with their neighbours ("1 – 2").
 * No text states a minimum or maximum, so changing data cannot make one
 * false.
 */
export function classLabels(
  paint: Pick<QuantileFill, "breaks" | "colors" | "wholeNumbers">,
): ClassLabel[] {
  const { breaks, colors } = paint;
  const last = colors.length - 1;
  const whole = countsByOne(paint);
  return colors.map((_, i) => {
    if (i === last) return { text: `> ${formatBreak(breaks[breaks.length - 1])}` };
    const upper = formatBreak(breaks[i]);
    if (i === 0) return { text: `≤ ${upper}`, lead: "≤" };
    if (!whole) {
      const lead = `${formatBreak(breaks[i - 1])} –`;
      return { text: `${lead} ${upper}`, lead };
    }
    const first = breaks[i - 1] + 1;
    if (first === breaks[i]) return { text: upper, lead: "" };
    const lead = `${formatBreak(first)} –`;
    return { text: `${lead} ${upper}`, lead };
  });
}
