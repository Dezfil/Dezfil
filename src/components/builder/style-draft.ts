import type { LayerStyle } from "@/lib/style/style";
import type { AppearanceDraft } from "./builder-shell-state";

/**
 * A style draft is what a moving control previews before the layer is
 * written. A slider writes on release only, so a value set without one
 * leaves its draft behind, and the layer can be written in the meantime
 * by an edit that does not preview, a fill switched to a ramp, say. The
 * draft therefore remembers the saved style it was taken from and keeps
 * only its own edits over whatever is saved now: a field it changed, while
 * the saved style still holds what the draft found there. A field written
 * since wins, and every field it never touched follows the saved style.
 */

const same = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

function rebase(
  style: LayerStyle,
  from: LayerStyle | undefined,
  saved: LayerStyle,
): LayerStyle {
  if (!from || from === saved) return style;
  const edited = style as unknown as Record<string, unknown>;
  const was = from as unknown as Record<string, unknown>;
  const now = saved as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...now };
  for (const key of new Set([...Object.keys(edited), ...Object.keys(was)])) {
    if (!same(edited[key], was[key]) && same(now[key], was[key])) out[key] = edited[key];
  }
  return out as unknown as LayerStyle;
}

/** The next style draft a preview leaves: the partial over the layer's
 * draft carried onto its saved style, or over the saved style when it has
 * none. */
export function nextStyleDraft(
  prior: AppearanceDraft | undefined,
  saved: LayerStyle,
  partial: Partial<LayerStyle>,
): AppearanceDraft {
  const base = prior?.style ? rebase(prior.style, prior.styleFrom, saved) : saved;
  return { ...prior, style: { ...base, ...partial }, styleFrom: saved };
}

/** The style the canvas and the legend draw for a layer: its draft's own
 * edits over its saved style, or the saved style when it has no draft. */
export function draftedStyle(
  saved: LayerStyle,
  draft: AppearanceDraft | undefined,
): LayerStyle {
  return draft?.style ? rebase(draft.style, draft.styleFrom, saved) : saved;
}
