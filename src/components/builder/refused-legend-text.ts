import type { Layer } from "@/lib/metadata/maps";
import type { LegendAttrs } from "@/lib/viz";
import type { LegendLiveText } from "./LegendTab";

/**
 * The Legend tab's live text left once the server refuses a save of it.
 * The refusal stored nothing, so the refused text leaves the legend: the
 * title, each label slot and each variable name still showing what the
 * refused save sent shows the stored text (`stored`: the server's layer
 * with the saves still pending over it) again, and one holding other text,
 * typed or saved since, keeps it. A field left showing only stored text
 * needs no live text and is dropped.
 */
export function withoutRefusedLegendText(
  live: LegendLiveText,
  refused: Record<string, unknown>,
  stored: Layer | undefined,
): LegendLiveText {
  const next: LegendLiveText = { ...live };
  if ("legendTitle" in refused && next.legendTitle !== undefined && next.legendTitle === refused.legendTitle) {
    delete next.legendTitle;
  }
  if ("legendLabels" in refused && next.legendLabels !== undefined) {
    const shown = stored?.legendLabels ?? null;
    const sent = (refused.legendLabels ?? null) as (string | null)[] | null;
    const local = next.legendLabels;
    const slots = Math.max(local?.length ?? 0, sent?.length ?? 0, shown?.length ?? 0);
    const merged = Array.from({ length: slots }, (_, i) =>
      (local?.[i] ?? null) === (sent?.[i] ?? null) ? (shown?.[i] ?? null) : (local?.[i] ?? null));
    const labels = merged.every((label) => label === null) ? null : merged;
    if (sameLabels(labels, shown)) delete next.legendLabels;
    else next.legendLabels = labels;
  }
  if ("legendAttrs" in refused && next.legendAttrs !== undefined) {
    const shown = stored?.legendAttrs ?? null;
    const sent = (refused.legendAttrs ?? null) as LegendAttrs | null;
    const local = next.legendAttrs;
    const channels = new Set([local, sent, shown].flatMap((attrs) => Object.keys(attrs ?? {})));
    const merged: Record<string, string | null> = {};
    for (const channel of channels) {
      const text = channelText(local, channel) === channelText(sent, channel) ? channelText(shown, channel) : channelText(local, channel);
      if (text !== undefined) merged[channel] = text;
    }
    const attrs = Object.keys(merged).length ? (merged as LegendAttrs) : null;
    if (sameAttrs(attrs, shown)) delete next.legendAttrs;
    else next.legendAttrs = attrs;
  }
  return next;
}

/** A channel's variable name: text, null when hidden, undefined when automatic. */
function channelText(attrs: LegendAttrs | null | undefined, channel: string): string | null | undefined {
  return attrs && Object.hasOwn(attrs, channel) ? (attrs as Record<string, string | null>)[channel] : undefined;
}

function sameLabels(a: (string | null)[] | null, b: (string | null)[] | null): boolean {
  const slots = Math.max(a?.length ?? 0, b?.length ?? 0);
  return Array.from({ length: slots }).every((_, i) => (a?.[i] ?? null) === (b?.[i] ?? null));
}

function sameAttrs(a: LegendAttrs | null, b: LegendAttrs | null): boolean {
  const channels = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...channels].every((channel) => channelText(a, channel) === channelText(b, channel));
}
