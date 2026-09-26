"use client";

import { useEffect, useRef, useState } from "react";
import type { FieldStats } from "@/lib/layer-service";
import type { LayerFilter } from "@/lib/viz";
import { numToRange } from "@/lib/live-filters";
import {
  exactText,
  resolutionFor,
  snap,
} from "@/lib/numeric-precision";
import { RangeBrush } from "./RangeBrush";
import styles from "../FilterSection.module.css";

export function NumericControl({
  filter,
  stats,
  columnType,
  onChange,
  onLive,
  onLiveStart,
  onLiveEnd,
  onFilterPreview,
  onFilterPreviewStart,
  onFilterPreviewEnd,
}: {
  filter: Extract<LayerFilter, { kind: "range" }>;
  stats?: FieldStats;
  /** The column's declared type — an integer column steps by whole numbers
   *  and shows no decimals. */
  columnType?: string;
  onChange: (f: LayerFilter) => Promise<boolean>;
  /** Live preview channel: mid-drag bounds reach the canvas
   * as a resolved GPU range — no state, no writes. */
  onLive?: (range: [number, number]) => void;
  onLiveStart?: () => void;
  onLiveEnd?: (accepted: boolean) => void;
  onFilterPreview?: (filter: LayerFilter) => void;
  onFilterPreviewStart?: () => void;
  onFilterPreviewEnd?: (accepted: boolean) => void;
}) {
  const extent = stats?.kind === "numeric" ? stats : null;
  const from = extent?.min ?? null;
  const to = extent?.max ?? null;
  const brushable = from !== null && to !== null && from < to;

  /* One resolution for the whole control: the step the brush
     moves by, and the decimals every bound is shown and stored at. */
  const res = resolutionFor(from ?? 0, to ?? 0, columnType);

  /* A slider position as the single number every consumer sees. The extremes
     stay exactly the extent so they keep meaning "open"; everything between
     lands on a round increment, which is what makes the readout, both live
     previews and the stored bound the same value rather than three roundings
     of one position. */
  const resolve = (v: number): number =>
    from === null || to === null
      ? v
      : v <= from
        ? from
        : v >= to
          ? to
          : snap(v, res);

  /** A bound as the readout shows it — empty when the bound is open.
   *
   *  A value the user typed may be finer than the slider's resolution, and
   *  formatting it at that resolution would print a number that is not the
   *  one being filtered. So the derived decimals are used only when they
   *  render the value exactly; anything finer is shown as it is stored. */
  const boundText = (v: number | null): string =>
    v === null ? "" : exactText(v, res);
  const [sel, setSel] = useState<[number, number]>([
    filter.min ?? from ?? 0,
    filter.max ?? to ?? 0,
  ]);
  const selRef = useRef(sel);
  const [minText, setMinText] = useState(
    filter.min === null ? "" : String(filter.min),
  );
  const [maxText, setMaxText] = useState(
    filter.max === null ? "" : String(filter.max),
  );
  const minTextRef = useRef(minText);
  const maxTextRef = useRef(maxText);
  const authoritativeRef = useRef(filter);
  const localRef = useRef(false);
  const pendingRef = useRef(0);
  const generationRef = useRef(0);

  useEffect(() => {
    authoritativeRef.current = filter;
    if (localRef.current || pendingRef.current > 0) return;
    const next: [number, number] = [
      filter.min ?? from ?? 0,
      filter.max ?? to ?? 0,
    ];
    selRef.current = next;
    // External authoritative changes (undo, agent/API edit) reset the draft.
    setSel(next);
    // Recomputed from primitives, so the effect does not re-run on every
    // render the way a fresh resolution object in its deps would make it.
    const external = resolutionFor(from ?? 0, to ?? 0, columnType);
    const nextMinText =
      filter.min === null ? "" : exactText(filter.min, external);
    const nextMaxText =
      filter.max === null ? "" : exactText(filter.max, external);
    minTextRef.current = nextMinText;
    maxTextRef.current = nextMaxText;
    setMinText(nextMinText);
    setMaxText(nextMaxText);
  }, [filter, from, to, columnType]);

  if (!stats) return <span className={styles.loading}>Loading…</span>;

  // Bounds at (or beyond) the extent mean "open" — removing the brush
  // restores the result exactly, like clearing a bound input.
  const beginInteraction = () => {
    localRef.current = true;
    generationRef.current += 1;
    onLiveStart?.();
    onFilterPreviewStart?.();
  };

  const resetToAuthoritative = () => {
    const current = authoritativeRef.current;
    const next: [number, number] = [
      current.min ?? from ?? 0,
      current.max ?? to ?? 0,
    ];
    selRef.current = next;
    setSel(next);
    const nextMinText = boundText(current.min);
    const nextMaxText = boundText(current.max);
    minTextRef.current = nextMinText;
    maxTextRef.current = nextMaxText;
    setMinText(nextMinText);
    setMaxText(nextMaxText);
    // Live filters update deck.gl imperatively during the drag. A rejected
    // save does not change React's authoritative filter props, so explicitly
    // restore that GPU range as part of rollback.
    onLive?.(next);
  };

  const commitSel = async () => {
    if (from === null || to === null) return;
    const generation = generationRef.current;
    localRef.current = false;
    pendingRef.current += 1;
    const lo = selRef.current[0];
    const hi = selRef.current[1];
    const min = lo <= from ? null : lo;
    const max = hi >= to ? null : hi;
    let accepted = false;
    try {
      accepted =
        min === filter.min && max === filter.max
          ? true
          : await onChange({ ...filter, min, max });
    } catch {
      accepted = false;
    } finally {
      pendingRef.current -= 1;
    }
    if (generation !== generationRef.current || localRef.current) return;
    if (accepted) {
      const nextMinText = boundText(min);
      const nextMaxText = boundText(max);
      minTextRef.current = nextMinText;
      maxTextRef.current = nextMaxText;
      setMinText(nextMinText);
      setMaxText(nextMaxText);
    } else {
      resetToAuthoritative();
    }
    onLiveEnd?.(accepted);
    onFilterPreviewEnd?.(accepted);
  };

  const commitText = async () => {
    const parse = (s: string) => {
      const n = Number(s);
      return s.trim() !== "" && Number.isFinite(n) ? n : null;
    };
    const min = parse(minTextRef.current);
    const max = parse(maxTextRef.current);
    const accepted = await onChange({
      ...filter,
      min,
      max,
    });
    if (accepted) {
      const next: [number, number] = [min ?? from ?? 0, max ?? to ?? 0];
      selRef.current = next;
      setSel(next);
    } else {
      resetToAuthoritative();
    }
  };

  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  // Mid-drag: thumbs move locally AND the map filters live. Bounds at the
  // extent preview as open — the same mapping the commit stores — so NULL
  // rows never flicker between drag and release.
  const livePreview = (raw: [number, number]) => {
    // Resolve first, then order: snapping moves a handle by up to half a
    // step, which can carry it past a sibling that sits off the lattice
    // (a typed bound finer than the slider's resolution).
    const a = resolve(raw[0]);
    const b = resolve(raw[1]);
    const next: [number, number] = [Math.min(a, b), Math.max(a, b)];
    selRef.current = next;
    setSel(next);

    // The readouts follow the handles (field note 4a) — they used to sit on
    // the last committed bounds until release. Writing them here also means
    // the released value stays on screen through the pending save, with no
    // flash back to the old bound and forward again.
    const min = from !== null && next[0] <= from ? null : next[0];
    const max = to !== null && next[1] >= to ? null : next[1];
    const nextMinText = boundText(min);
    const nextMaxText = boundText(max);
    minTextRef.current = nextMinText;
    maxTextRef.current = nextMaxText;
    setMinText(nextMinText);
    setMaxText(nextMaxText);

    // Both live channels take the same resolved number as the commit will.
    if (onLive && from !== null && to !== null) onLive(numToRange(min, max));
    if (onFilterPreview && from !== null && to !== null) {
      onFilterPreview({ ...filter, min, max });
    }
  };

  return (
    <>
      {brushable && (
        <RangeBrush
          from={from}
          to={to}
          sel={sel}
          step={res.step}
          bins={extent?.bins ?? []}
          onPreview={livePreview}
          onStart={beginInteraction}
          onCommit={commitSel}
        />
      )}
      <div className={styles.range}>
        <input
          className={styles.bound}
          type="number"
          value={minText}
          placeholder={from !== null ? exactText(from, res) : "min"}
          aria-label={`${filter.field} minimum`}
          onChange={(e) => {
            minTextRef.current = e.target.value;
            setMinText(e.target.value);
          }}
          onBlur={() => void commitText()}
          onKeyDown={blurOnEnter}
        />
        <span className={styles.to}>–</span>
        <input
          className={styles.bound}
          type="number"
          value={maxText}
          placeholder={to !== null ? exactText(to, res) : "max"}
          aria-label={`${filter.field} maximum`}
          onChange={(e) => {
            maxTextRef.current = e.target.value;
            setMaxText(e.target.value);
          }}
          onBlur={() => void commitText()}
          onKeyDown={blurOnEnter}
        />
      </div>
    </>
  );
}
