"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelKnowledge } from "@/lib/assistant/model-knowledge";
import { ChevronIcon } from "../../ui/icons";
import { chipWords, menuEfforts, type ModelChoice } from "./model-choice";
import { useModelChoice } from "./model-choice-store";
import { menuKey } from "./model-menu-keys";
import { useMenuRoom } from "./menu-room";
import { ModelMenu } from "./ModelMenu";
import styles from "./ModelPicker.module.css";

/**
 * The model and effort picker: a chip in the composer's footer row,
 * replacing the pane's model line, with its menu opening upward inside the
 * pane.
 *
 * It stands only where the instance offers something to choose; a
 * single-model instance keeps today's quiet model line and this never
 * renders. Disabled while a turn is in flight and while a confirmation
 * waits, and a disabled chip holds no open menu.
 *
 * The keyboard is `model-menu-keys.ts`'s rule; this moves the focus it
 * names. Closing from inside returns focus to the chip, and Escape is
 * consumed only while the menu is open, so the same press never also
 * dismisses the pane. Focus or a pointer leaving the picker closes the menu
 * too, and leaves the focus where it went: an Escape pressed elsewhere must
 * never find a menu still open, or it would close the pane over one.
 *
 * While a run owns the pane — executing, or waiting at a confirmation card,
 * or recovered from the server — the chip reads that run's own bound pair
 * and is locked. A control that displayed one pair and
 * offered to change another would be lying about which it meant, and the
 * bound pair is a settled fact: the request has already gone. At rest the
 * chip is the next message's selection again.
 */
export function ModelPicker({ models, instanceModel, disabled, bound, payer }: {
  models: ModelKnowledge[];
  /** The instance's own default, which is what nothing remembered means. */
  instanceModel: string;
  disabled: boolean;
  /** The pair the run now on display bound, where one is; it may name an
   * identity this instance no longer offers, and is read as itself. */
  bound?: ModelChoice;
  /** Which key pays, where there are two it could be. */
  payer?: string | null;
}) {
  const { choice, pickModel, pickEffort } = useModelChoice(models, instanceModel);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  /** A bound run locks the control as firmly as the phase does. */
  const off = disabled || bound !== undefined;
  const shown = open && !off;
  /** The walk's order is the menu's reading order: the models, then the
   * selected model's levels. */
  const count = models.length + menuEfforts(models, choice.model).length;

  const close = useCallback(() => {
    setOpen(false);
    chipRef.current?.focus();
  }, []);
  /** Closing because the person went elsewhere: the menu goes, the focus
   * stays where they put it. */
  const dismiss = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!shown) return;
    const elsewhere = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapRef.current?.contains(target)) return;
      dismiss();
    };
    document.addEventListener("pointerdown", elsewhere, true);
    return () => document.removeEventListener("pointerdown", elsewhere, true);
  }, [dismiss, shown]);
  /** A picker disabled under an open menu drops the menu without stealing
   * focus — the composer's hand-off decides where focus goes at that moment
   * — and does not reopen it when the turn settles. Adjusted during render
   * rather than in an effect, so no menu is ever painted for a disabled
   * control. */
  const [wasOff, setWasOff] = useState(off);
  if (wasOff !== off) {
    setWasOff(off);
    if (off && open) setOpen(false);
  }
  useEffect(() => { if (shown) items.current[index]?.focus(); }, [shown, index]);
  /** The menu's ceiling inside the pane, so it never leaves the pane at
   * either width and scrolls inside only when its rows would not fit. */
  useMenuRoom(wrapRef, shown);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const action = menuKey(event.key, { open: shown, index, count, disabled: off });
    if (action.kind === "ignore") return;
    event.preventDefault();
    if (action.kind === "close") { close(); return; }
    setIndex(action.index);
    if (action.kind === "open") setOpen(true);
  };

  const words = chipWords(models, bound ?? choice);
  const pick = (apply: () => void) => { apply(); close(); };
  return (
    <span
      ref={wrapRef}
      className={styles.wrap}
      data-model-choice
      onKeyDown={onKeyDown}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) dismiss(); }}
    >
      <button
        ref={chipRef}
        type="button"
        className={styles.chip}
        data-model-picker
        aria-haspopup="menu"
        aria-expanded={shown}
        disabled={off}
        onClick={() => { setIndex(0); setOpen((was) => !was); }}
      >
        <b>{words.name}</b>
        {words.effort && <span>· {words.effort}</span>}
        {payer && <span>· {payer}</span>}
        <ChevronIcon />
      </button>
      {shown && (
        <ModelMenu
          models={models}
          choice={choice}
          onPickModel={(id) => pick(() => pickModel(id))}
          onPickEffort={(value) => pick(() => pickEffort(value))}
          itemRef={(at) => (element) => { items.current[at] = element; }}
        />
      )}
    </span>
  );
}
