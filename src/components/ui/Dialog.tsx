"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Dialog.module.css";

/** The modality contract, not merely a shell.
 *
 * Add data and Add to map rendered a scrim, focused the card and honoured
 * Escape, but left focus free to Tab out into a live page behind them and
 * dropped it on the document when they closed. The add-layer
 * catalog had the whole contract — locally, in its own copy. This owns it
 * once: an accessible name, initial focus inside, Tab and Shift+Tab
 * containment, the background inert while open, Escape, and focus returned
 * to whatever opened the dialog, or, when the confirmed action removed it
 * (a card's own Delete), to the page's main heading, else its main region,
 * never to the document. Focus also stays inside while a control holding
 * it is disabled in flight, and returns to it if a refusal re-enables it.
 *
 * The dialog portals to its own body-level host, and that is what makes
 * inertness real: marking body-level siblings only disables the background
 * if the dialog is not *inside* the subtree being skipped. Rendered in
 * place, the ancestor holding the dialog is the ancestor holding the whole
 * page, so the sweep skipped everything — the shape the review caught, and
 * the shape the old local copies had. Inertness restores exactly what it
 * marked, so an unrelated pre-existing `inert` is never stripped, and
 * nothing unmounts: a live WebGL canvas and its in-flight state sit back
 * there. */
export function Dialog({
  label,
  onClose,
  className,
  scrimClassName,
  children,
  ...data
}: {
  /** The dialog's accessible name. */
  label: string;
  onClose: () => void;
  className?: string;
  scrimClassName?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // The host node is minted once, in a state initialiser rather than an
  // effect: an effect would render the dialog nowhere on the first pass and
  // then again once the host existed. It is only attached in the effect
  // below, so a server render and a discarded double-invoke both leave an
  // unattached node the collector takes.
  const [host] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    const mount = document.createElement("div");
    mount.dataset.dialogHost = "";
    return mount;
  });

  useEffect(() => {
    if (!host) return;
    document.body.appendChild(host);
    return () => host.remove();
  }, [host]);

  // The control inside that last took focus, and one that lost focus by
  // turning disabled, waiting to have it back.
  const lastFocused = useRef<HTMLElement | null>(null);
  const parked = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!host) return;
    const opener = document.activeElement as HTMLElement | null;
    const card = dialogRef.current;
    const onFocusIn = (e: Event) => {
      lastFocused.current = e.target as HTMLElement;
    };
    card?.addEventListener("focusin", onFocusIn);
    card?.focus();
    const marked: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === host || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      marked.push(child);
    }
    return () => {
      card?.removeEventListener("focusin", onFocusIn);
      for (const el of marked) el.removeAttribute("inert");
      if (!takesFocus(opener)) landOnPage();
    };
  }, [host]);

  // A disabled control cannot hold focus: a browser drops it on the
  // document, behind the modal, at once or after the render. Every render
  // that leaves the focused control (or the last one focused, when focus
  // already went) disabled moves focus to the dialog itself, and a render
  // that enables it again while focus still waits there gives it back.
  useLayoutEffect(() => {
    const card = dialogRef.current;
    if (!card) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== card && card.contains(active)) {
      if (!isDisabled(active)) {
        parked.current = null;
        return;
      }
      parked.current = active;
      card.focus();
      return;
    }
    if (active === card || !card.contains(active)) {
      const last = lastFocused.current;
      if (active !== card && last && last !== card && card.contains(last) && isDisabled(last)) {
        parked.current = last;
        card.focus();
        return;
      }
      const control = parked.current;
      if (control && card.contains(control) && !isDisabled(control)) {
        parked.current = null;
        control.focus();
      }
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consumed: an outer surface must not also dismiss on this press.
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Containment. Inertness already stops most escapes, but the browser
      // chrome's own tab stops and any portalled sibling would still take
      // focus out of a modal; the cycle keeps it here.
      const card = dialogRef.current;
      if (!card) return;
      const stops = [
        ...card.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (stops.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!host) return null;

  return createPortal(
    <div
      className={
        scrimClassName ? `${styles.scrim} ${scrimClassName}` : styles.scrim
      }
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        {...data}
        ref={dialogRef}
        className={className ? `${styles.dialog} ${className}` : styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    host,
  );
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true;
}

/** Focus the element if it is still on the page and takes focus. */
function takesFocus(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  el.focus();
  return document.activeElement === el;
}

/** Where focus lands when its opener is gone: the main region's heading,
 * else the region itself, focusable for this landing only. */
function landOnPage() {
  const main = document.querySelector<HTMLElement>("main");
  const target = main?.querySelector<HTMLElement>("h1") ?? main;
  if (!target) return;
  if (target.hasAttribute("tabindex")) {
    target.focus();
    return;
  }
  target.setAttribute("tabindex", "-1");
  target.focus();
  if (document.activeElement === target) {
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  } else {
    target.removeAttribute("tabindex");
  }
}
