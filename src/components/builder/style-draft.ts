import type { LayerStyle } from "@/lib/style/style";
import type { AppearanceDraft } from "./builder-shell-state";

/**
 * A style draft is what a moving control previews before the layer is
 * written. A slider writes on release only, so a value set without one
 * leaves its draft behind, and the layer can be written in the meantime
 * by an edit that does not preview, a fill switched to a ramp, say. The
 * draft therefore remembers the style it was taken from and keeps only its
 * own edits over the layer's style now: a field it changed, while the
 * style still holds what the draft found there. A field written since
 * wins, and every field it never touched follows the layer's style.
 *
 * The style a draft is taken from is the one the canvas and the legend
 * draw it over: the layer as the map shows it, with any save still in
 * flight already in place. A preview taken while an earlier save of the
 * same field is settling then holds through that settling, which leaves
 * the field as the draft found it, and gives way only to a later write.
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
 * draft carried onto the layer's style, or over that style when it has
 * none. The style is the one the map shows, `shown`, and the saved one
 * only when the map does not show the layer. */
export function nextStyleDraft(
  prior: AppearanceDraft | undefined,
  saved: LayerStyle,
  partial: Partial<LayerStyle>,
  shown: LayerStyle | undefined,
): AppearanceDraft {
  const from = shown ?? saved;
  const base = prior?.style ? rebase(prior.style, prior.styleFrom, from) : from;
  return { ...prior, style: { ...base, ...partial }, styleFrom: from };
}

/** The style the canvas and the legend draw for a layer: its draft's own
 * edits over its saved style, or the saved style when it has no draft. */
export function draftedStyle(
  saved: LayerStyle,
  draft: AppearanceDraft | undefined,
): LayerStyle {
  return draft?.style ? rebase(draft.style, draft.styleFrom, saved) : saved;
}
