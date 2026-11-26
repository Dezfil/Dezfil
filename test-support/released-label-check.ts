/**
 * The label check as an earlier release holds it, frozen: copied without
 * change from `src/lib/style/style.ts` at commit 8dfc04ec, the same text
 * release 0.2.0 shipped. That release reads a template's map document
 * only if every layer's label passes this check, and it draws the label's
 * `color`, `haloWidth` and `haloColor` as given. A template is made from a
 * project export, so every label this version exports or serves in a
 * template must keep passing it. Never update it to follow the current
 * check: its use is to be the older one.
 */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const LABEL_SIZE_MAX_PX = 72;
export const LABEL_ANCHORS = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export const LABEL_CASES = ["as-is", "upper", "lower"] as const;
export const LABEL_OFFSET_MAX = 50;
export const LABEL_ROTATION_MAX = 180;
export const LABEL_HALO_WIDTH_MAX = 3;
export const LABEL_MAX_CHARS = { min: 1, max: 80 } as const;
export const LABEL_CAP = { min: 1, max: 10_000 } as const;

/** Why a label config is invalid, or null. Field-specific wordings —
 * the documented contract. */
export function labelProblem(value: unknown): string | null {
  if (!value || typeof value !== "object")
    return "label must be a label object.";
  const l = value as Record<string, unknown>;
  if (
    l.attribute !== undefined &&
    (typeof l.attribute !== "string" || l.attribute.length === 0)
  )
    return "label.attribute must be a non-empty attribute name when present.";
  if (
    typeof l.size !== "number" ||
    !Number.isFinite(l.size) ||
    l.size < 1 ||
    l.size > LABEL_SIZE_MAX_PX
  )
    return `label.size must be a number of pixels, 1 to ${LABEL_SIZE_MAX_PX}.`;
  if (!isColor(l.color)) return "label needs a valid color.";
  if (l.halo !== undefined)
    return (
      `label.halo has been replaced: send label.haloWidth (0 to ${LABEL_HALO_WIDTH_MAX}) and ` +
      "label.haloColor. Stored maps migrate on read."
    );
  if (
    typeof l.haloWidth !== "number" ||
    !Number.isFinite(l.haloWidth) ||
    l.haloWidth < 0 ||
    l.haloWidth > LABEL_HALO_WIDTH_MAX
  )
    return `label.haloWidth must be a number, 0 to ${LABEL_HALO_WIDTH_MAX} (0 = no halo).`;
  if (!isColor(l.haloColor)) return "label.haloColor must be a valid color.";
  if (
    l.weight !== undefined &&
    l.weight !== "normal" &&
    l.weight !== "bold"
  )
    return 'label.weight accepts "normal" or "bold".';
  if (
    l.anchor !== undefined &&
    !(LABEL_ANCHORS as readonly unknown[]).includes(l.anchor)
  )
    return `label.anchor accepts ${LABEL_ANCHORS.join(", ")}.`;
  for (const axis of ["offsetX", "offsetY"] as const) {
    const v = l[axis];
    if (
      v !== undefined &&
      (typeof v !== "number" ||
        !Number.isFinite(v) ||
        Math.abs(v) > LABEL_OFFSET_MAX)
    )
      return `label.${axis} must be a number of pixels, -${LABEL_OFFSET_MAX} to ${LABEL_OFFSET_MAX}.`;
  }
  if (
    l.rotation !== undefined &&
    (typeof l.rotation !== "number" ||
      !Number.isFinite(l.rotation) ||
      Math.abs(l.rotation) > LABEL_ROTATION_MAX)
  )
    return `label.rotation must be degrees, -${LABEL_ROTATION_MAX} to ${LABEL_ROTATION_MAX} (counter-clockwise positive).`;
  if (
    l.textCase !== undefined &&
    !(LABEL_CASES as readonly unknown[]).includes(l.textCase)
  )
    return `label.textCase accepts ${LABEL_CASES.join(", ")}.`;
  if (
    l.maxChars !== undefined &&
    l.maxChars !== null &&
    (typeof l.maxChars !== "number" ||
      !Number.isInteger(l.maxChars) ||
      l.maxChars < LABEL_MAX_CHARS.min ||
      l.maxChars > LABEL_MAX_CHARS.max)
  )
    return `label.maxChars must be a whole number, ${LABEL_MAX_CHARS.min} to ${LABEL_MAX_CHARS.max}, or null for no truncation.`;
  if (
    l.density !== undefined &&
    (typeof l.density !== "number" ||
      !Number.isFinite(l.density) ||
      l.density < 0 ||
      l.density > 1)
  )
    return "label.density must be a number, 0 (sparse) to 1 (dense).";
  if (
    l.zoomFloor !== undefined &&
    l.zoomFloor !== null &&
    (typeof l.zoomFloor !== "number" ||
      !Number.isInteger(l.zoomFloor) ||
      l.zoomFloor < 0 ||
      l.zoomFloor > 24)
  )
    return "label.zoomFloor must be a whole zoom level, 0 to 24, or null for none.";
  if (
    l.priorityField !== undefined &&
    l.priorityField !== null &&
    (typeof l.priorityField !== "string" || l.priorityField.length === 0)
  )
    return "label.priorityField must be a non-empty column name, or null for feature order.";
  if (
    l.cap !== undefined &&
    l.cap !== null &&
    (typeof l.cap !== "number" ||
      !Number.isInteger(l.cap) ||
      l.cap < LABEL_CAP.min ||
      l.cap > LABEL_CAP.max)
  )
    return `label.cap must be a whole number, ${LABEL_CAP.min} to ${LABEL_CAP.max}, or null for no cap.`;
  return null;
}

function isColor(value: unknown): value is RgbaColor {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    channel(c.r) &&
    channel(c.g) &&
    channel(c.b) &&
    typeof c.a === "number" &&
    c.a >= 0 &&
    c.a <= 1
  );
}

function channel(v: unknown): boolean {
  return typeof v === "number" && v >= 0 && v <= 255;
}
