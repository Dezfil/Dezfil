"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconTrash } from "./gallery-icons";
import gallery from "./gallery.module.css";

/**
 * A card's delete in place, on the Maps, Workflows, Projects and Data
 * lists: the first press arms it (the button asks its question), the
 * second deletes, and leaving the button disarms it.
 *
 * The deleted card takes its focused button with it, and a browser then
 * drops focus on the document, so the next Tab starts from the top of the
 * page. When a press that confirmed with focus here ends with the card
 * gone, focus moves to the next card's delete, else the previous card's,
 * else the list's heading. A deletion that fails leaves the card, and
 * focus returns to the button if the in-flight disabling dropped it.
 *
 * One delete is armed at a time on the page: arming another disarms it.
 * Leaving the button is not enough for that, since a browser whose pointer
 * clicks do not focus a button never blurs it, and an armed delete left
 * behind another would delete on one press.
 */
export function CardDelete({
  label,
  armedLabel,
  hint,
  armedHint,
  question,
  disabled = false,
  onConfirm,
}: {
  /** The accessible name before the first press. */
  label: string;
  /** The accessible name while armed. */
  armedLabel: string;
  hint: string;
  /** The hint while armed; none when the question says it all. */
  armedHint?: string;
  /** What the armed button reads, the page's own words. */
  question: string;
  /** True while the deletion is in flight. */
  disabled?: boolean;
  onConfirm: () => unknown;
}) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // This control's entry while it is the one armed.
  const self = useRef<Armed>({ disarm: () => setArmed(false) });
  const arm = () => {
    if (armedNow && armedNow !== self.current) armedNow.disarm();
    armedNow = self.current;
    setArmed(true);
  };
  const disarm = () => {
    if (armedNow === self.current) armedNow = null;
    setArmed(false);
  };
  // Set by a confirming press made with focus on this button: every
  // card's delete, in page order, as they stood at that press.
  const peers = useRef<HTMLElement[] | null>(null);
  const wasDisabled = useRef(disabled);

  // Back from the flight with the card still here: the deletion failed.
  useLayoutEffect(() => {
    const returned = wasDisabled.current && !disabled;
    wasDisabled.current = disabled;
    const button = ref.current;
    if (!returned || !peers.current || !button) return;
    peers.current = null;
    if (focusLost(button)) button.focus();
  }, [disabled]);

  // Gone with the card. A passive cleanup, so the commit that removed the
  // card has finished: React puts focus back where it was before a commit,
  // and a landing made during it would be undone.
  useEffect(() => {
    const button = ref.current;
    const entry = self.current;
    return () => {
      if (armedNow === entry) armedNow = null;
      if (button && peers.current && focusLost(button)) land(button, peers.current);
    };
  }, []);

  return (
    <button
      ref={ref}
      className={gallery.deleteAct}
      data-card-delete
      data-confirm={armed || undefined}
      disabled={disabled}
      data-hint={armed ? armedHint : hint}
      aria-label={armed ? armedLabel : label}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          arm();
          return;
        }
        const button = e.currentTarget;
        peers.current =
          document.activeElement === button
            ? Array.from(document.querySelectorAll<HTMLElement>("[data-card-delete]"))
            : null;
        void Promise.resolve(onConfirm()).finally(disarm);
      }}
      onBlur={disarm}
    >
      {armed ? question : <IconTrash />}
    </button>
  );
}

type Armed = { disarm: () => void };
/** The page's one armed delete, if any. */
let armedNow: Armed | null = null;

/** Focus is still on the button, or the page dropped it. */
function focusLost(button: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === button ||
    active === document.body ||
    !active.isConnected
  );
}

/** The next card's delete, else the previous card's, else the heading. */
function land(button: HTMLElement, peers: HTMLElement[]) {
  const at = peers.indexOf(button);
  const order = at < 0 ? [] : [...peers.slice(at + 1), ...peers.slice(0, at).reverse()];
  for (const peer of order) {
    if (!peer.isConnected || (peer as HTMLButtonElement).disabled) continue;
    peer.focus();
    if (document.activeElement === peer) return;
  }
  const heading = document.querySelector("[data-list-heading]")?.querySelector<HTMLElement>("h1");
  if (!heading) return;
  if (heading.hasAttribute("tabindex")) {
    heading.focus();
    return;
  }
  // The heading takes focus for this landing only.
  heading.setAttribute("tabindex", "-1");
  heading.focus();
  if (document.activeElement === heading) {
    heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
  } else {
    heading.removeAttribute("tabindex");
  }
}
