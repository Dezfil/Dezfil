"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeHint, settleHint, type ShownHint } from "./hint-placement";
import styles from "./HintLayer.module.css";

/**
 * The one tooltip: a single floating bubble serving every control that
 * carries `data-hint`, drawn in a portal so clipped and transformed
 * hosts (cards, the status pill) cannot cage it — the Menu primitive's
 * recorded precedent. Visual-only: accessible names stay on the
 * controls; the bubble is aria-hidden.
 *
 * The ruled boundaries live here once rather than per surface:
 * a control whose visible wording already explains it shows nothing —
 * so a responsively labelled control hints only while its label is
 * hidden — and the bubble flips and shifts to stay inside the viewport.
 * Inside a host marked `data-hint-place="beside"` (the rail) the bubble
 * stands beside its control instead (hint-placement.ts).
 *
 * Mount one layer per theme scope: the workspace shell, and the
 * published page's theme-scoped wrapper.
 */

const SHOW_DELAY_MS = 150;

/** A trigger with visible wording explains itself — no bubble. The
 * check is live, so a label hidden at a compact width re-arms it. */
function hasVisibleText(el: HTMLElement): boolean {
  for (const child of Array.from(el.children)) {
    const node = child as HTMLElement;
    if (node.dataset.hintIgnoreText !== undefined) continue;
    if (
      node.textContent?.trim() &&
      node.offsetWidth > 0 &&
      getComputedStyle(node).display !== "none"
    ) {
      return true;
    }
  }
  // Direct text nodes (buttons whose label is bare text).
  const direct = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent?.trim() ?? "")
    .join("");
  return direct.length > 0;
}

interface Shown extends ShownHint {
  text: string;
}

export function HintLayer({
  scope,
}: {
  scope?: React.RefObject<HTMLElement | null>;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const shownRef = useRef(false);
  const timer = useRef(0);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  /** The control the bubble currently belongs to — every pointer event
   * that resolves elsewhere disarms it, so a control that can emit no
   * pointerout (a natively disabled button) can never strand one. */
  const armedRef = useRef<HTMLElement | null>(null);
  /** Where the last press happened: native tooltips do not reappear
   * under a pointer that clicked and never moved, and DOM mutations
   * (screenshot masks included) re-synthesize hover at exactly that
   * point. Any real movement clears it. */
  const pressPos = useRef<{ x: number; y: number } | null>(null);
  /** The pointer's last real position. A boundary event at exactly this
   * point is the engine re-synthesizing hover for a DOM change under a
   * resting pointer (a map settling late), not an approach — it must not
   * take a bubble that keyboard focus earned. */
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const keyArmed = useRef(false);

  useEffect(() => {
    const root: HTMLElement | Document = scope?.current ?? document;

    const place = (target: HTMLElement, text: string) => {
      const beside = target.closest('[data-hint-place="beside"]') !== null;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      shownRef.current = true;
      setShown({ text, ...placeHint(target.getBoundingClientRect(), text, viewport, beside ? "beside" : "below") });
    };

    const arm = (target: HTMLElement) => {
      const text = target.dataset.hint;
      if (!text) return;
      if (target.dataset.hintAlways === undefined && hasVisibleText(target))
        return;
      armedRef.current = target;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => place(target, text),
        SHOW_DELAY_MS,
      );
    };

    const disarm = () => {
      armedRef.current = null;
      keyArmed.current = false;
      shownRef.current = false;
      window.clearTimeout(timer.current);
      setShown(null);
    };

    const resolve = (e: Event): HTMLElement | null => {
      const direct = (e.target as Element | null)?.closest?.("[data-hint]");
      if (direct instanceof HTMLElement) return direct;
      if (e instanceof PointerEvent) {
        // A natively disabled control swallows its pointer events; the
        // browser retargets to an ancestor. Hit-test the point so the
        // disabled control's reason still shows.
        const hit = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest?.("[data-hint]");
        if (hit instanceof HTMLElement) return hit;
      }
      return null;
    };

    const over = (e: Event) => {
      if (e instanceof PointerEvent && pressPos.current) {
        if (
          e.clientX === pressPos.current.x &&
          e.clientY === pressPos.current.y
        )
          return; // synthesized at the press point — not an approach
        pressPos.current = null;
      }
      if (e instanceof PointerEvent) {
        const p = lastPos.current;
        const same = p !== null && e.clientX === p.x && e.clientY === p.y;
        if (!same) lastPos.current = { x: e.clientX, y: e.clientY };
        if (same && keyArmed.current) return;
      }
      const target = resolve(e);
      if (target === armedRef.current) return;
      disarm();
      if (target) arm(target);
    };
    // Disabled controls emit no boundary events at all in some engines —
    // a throttled move keeps the hit-test honest wherever the pointer
    // actually is. The latest event of the frame is the one hit-tested;
    // keyboard focus arriving first drops it, so a frame delayed past the
    // focus cannot resolve an older pointer position over the bubble it
    // just earned (a busy first render did exactly that).
    let pending: Event | null = null;
    const move = (e: Event) => {
      const queued = pending !== null;
      pending = e;
      if (queued) return;
      requestAnimationFrame(() => {
        const ev = pending;
        pending = null;
        if (ev) over(ev);
      });
    };
    const out = (e: Event) => {
      const target = (e.target as Element | null)?.closest?.("[data-hint]");
      if (!target) return;
      // Movement between a button's nested SVG parts bubbles pointerout
      // with both sides still inside the trigger — that is not a leave.
      if (e instanceof PointerEvent) {
        const to = e.relatedTarget as Element | null;
        if (to && target.contains(to)) return;
        if (to?.closest?.("[data-hint]") === target) return;
      }
      disarm();
    };
    const focusIn = (e: Event) => {
      const target = (e.target as Element | null)?.closest?.("[data-hint]");
      // Keyboard focus only: a click parks focus too, and a bubble that
      // outlives its click strands over the map (journey pixel polls
      // caught exactly that).
      if (target instanceof HTMLElement && target.matches(":focus-visible")) {
        pending = null;
        arm(target);
        keyArmed.current = armedRef.current === target;
      }
    };
    // Activation hides the bubble, as native tooltips do — and pins the
    // press point so synthesized hover there cannot re-arm it.
    const down = (e: Event) => {
      if (e instanceof PointerEvent)
        pressPos.current = { x: e.clientX, y: e.clientY };
      disarm();
    };

    // The bubble's lease (the journey's stranded-Undo class): while it shows, the engine's own
    // truth —:hover or keyboard focus on the armed control — is re-checked; the moment neither
    // holds, it goes. Event choreography approximates that truth; this enforces it.
    const lease = window.setInterval(() => {
      const el = armedRef.current;
      if (!el) {
        // A bubble with no armed owner is a stranding, whatever left it.
        if (shownRef.current) disarm();
        return;
      }
      if (!el.isConnected) return disarm();
      if (el.matches(":hover") || el.matches(":focus-visible")) return;
      disarm();
    }, 300);

    root.addEventListener("pointerover", over);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerout", out);
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", out);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("scroll", disarm, true);
    return () => {
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerout", out);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", out);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("scroll", disarm, true);
      window.clearInterval(lease);
      window.clearTimeout(timer.current);
    };
  }, [scope]);

  // Second pass: the first placement estimates width; once
  // the bubble renders, measure it and pull it fully inside the padded
  // viewport, flipping above (or, beside the rail, sliding) when the real
  // height crosses the bottom.
  useEffect(() => {
    if (!shown) return;
    const el = bubbleRef.current;
    if (!el) return;
    const { x, y, above } = settleHint(shown, el.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (
      Math.round(x) !== Math.round(shown.x) ||
      Math.round(y) !== Math.round(shown.y) ||
      above !== shown.above
    ) {
      setShown({ ...shown, x, y, above });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.text, shown?.y]);

  const host =
    scope?.current ?? (typeof document !== "undefined" ? document.body : null);
  if (!shown || !host) return null;
  return createPortal(
    <div
      ref={bubbleRef}
      className={styles.bubble}
      aria-hidden
      data-hint-bubble
      data-above={shown.above || undefined}
      data-beside={shown.beside || undefined}
      style={{ left: shown.x, top: shown.y }}
    >
      {shown.text}
    </div>,
    host,
  );
}
