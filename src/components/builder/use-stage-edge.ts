"use client";

import { useEffect, useState } from "react";

/**
 * The stage's left edge, read from the one place that defines it.
 *
 * **There is one source of truth and this is how TSX reads it.** The edge used
 * to be a literal in eight CSS sites with four more derived by hand, plus a
 * parallel set below the breakpoint — and a thirteenth copy in component code,
 * where the camera's padding repeated the number outright. Twelve places had to
 * agree for one edge to move, and two of them already did not.
 *
 * A drawer moves that edge, so the copies had to go before the drawer arrived.
 * The CSS custom property is the definition; this reads the computed value, so
 * a change to the property moves the camera with everything else rather than
 * leaving the map framed for a layout that no longer exists.
 *
 * It re-reads on resize because the property changes at the shell's breakpoint,
 * and whenever the caller says the drawer moved.
 *
 * **The value this returns is published on the stage as `data-stage-edge`.**
 * It is the number handed to the camera, not a copy made for a test: a browser
 * can therefore count how many times the edge *commits* across a drag, which
 * is what is asked for. Watching the map eventually settle would pass
 * against a per-frame commit too, which is the version of that check that
 * cannot fail.
 */
export interface StageEdges {
  left: number;
  right: number;
}

/**
 * Both edges as one commit: the assistant docks on the right as the
 * drawer docks on the left, and a replacement moves both edges together,
 * so they are read together and delivered to the camera as one padding
 * change.
 */
export function useStageEdges(committedAt?: unknown): StageEdges {
  const [edges, setEdges] = useState<StageEdges>({ left: FALLBACK_EDGE, right: FALLBACK_RIGHT });

  // **Commits, not frames**. `committedAt` changes when a helper opens,
  // closes, replaces the other or the width crosses a band, and never per
  // frame. The canvas eases the camera over 300 ms on every change to its
  // padding, so a per-frame commit would ease an animation against a
  // moving target — the camera chasing a number that has already moved
  // again.
  useEffect(() => {
    const read = () => {
      const next = { left: currentStageEdge(), right: currentStageRight() };
      setEdges((prior) => (prior.left === next.left && prior.right === next.right ? prior : next));
    };
    // A frame later: the property is written by the drawer's own effect, and
    // reading in the same tick can see the value it had before that ran.
    const raf = requestAnimationFrame(read);
    window.addEventListener("resize", read);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", read);
    };
  }, [committedAt]);

  return edges;
}

/**
 * What the shell uses before the browser has computed anything.
 *
 * Not a second definition: it is the value the property takes at the wide
 * breakpoint, and it is only ever seen during server rendering and the first
 * paint. A wrong number here would frame the very first camera slightly off and
 * then correct itself, which is why it is stated rather than guessed at zero.
 */
export const FALLBACK_EDGE = 438;
/** The stage's right edge before the browser has computed anything: the
 * screen's gutter, with no assistant docked. */
export const FALLBACK_RIGHT = 14;

/**
 * **The edge is summed here because the browser will not sum it for us.**
 *
 * `--stage-left` is `calc(var(--stage-left-base) + var(--drawer-offset))`, and
 * an unregistered custom property computes to its token sequence rather than to
 * a resolved length: `getPropertyValue` hands back the literal `calc(…)` text,
 * which parses to NaN. Reading it that way silently returned the fallback for
 * every drawer width there is — the camera framed for a closed drawer, for
 * ever, with nothing in the DOM to show for it. Criterion 7's commit count is
 * what found it: zero commits across a drag that plainly moved the stage.
 *
 * So the properties that *define* the edge are read and added: the base,
 * what an open drawer adds and what the always-open rail adds (the root's
 * `--rail-shift`, inherited by the body). That is still one source — no
 * number is written here — and it needs no registered property, which would
 * put the same failure back in any browser that does not support one.
 */
export function currentStageEdge(): number {
  if (typeof window === "undefined") return FALLBACK_EDGE;
  const styles = window.getComputedStyle(document.body);
  const base = Number.parseFloat(styles.getPropertyValue("--stage-left-base"));
  if (!Number.isFinite(base) || base <= 0) return FALLBACK_EDGE;
  const added = (name: string) => {
    const value = Number.parseFloat(styles.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  };
  return base + added("--drawer-offset") + added("--rail-shift");
}

/** The right edge, summed the same way: the gutter plus what a docked
 * assistant adds (`--assistant-offset`, one writer). */
export function currentStageRight(): number {
  if (typeof window === "undefined") return FALLBACK_RIGHT;
  const styles = window.getComputedStyle(document.body);
  const gutter = Number.parseFloat(styles.getPropertyValue("--gutter"));
  const offset = Number.parseFloat(styles.getPropertyValue("--assistant-offset"));
  if (!Number.isFinite(gutter) || gutter <= 0) return FALLBACK_RIGHT;
  return gutter + (Number.isFinite(offset) ? offset : 0);
}
