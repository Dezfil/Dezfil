"use client";

import { useEffect, useRef } from "react";
import { Textarea } from "../../ui/Field";
import { StopIcon } from "../../ui/icons";
import { composerWorking, showsStop, type TurnPhase } from "./turn-phase";
import { focusLanding, focusPlace, type FocusPlace } from "./composer-focus";
import { ASSISTANT_INPUT } from "./clear-control";
import styles from "../AssistantPanel.module.css";

/**
 * The composer: the input and one control in the Send slot. While the turn
 * executes or waits at a card, the input is disabled with "Working…" and
 * the slot's control reads Stop; during a recovery read and at rest it
 * reads Send. The control is one element whose word, type and handler
 * change with the phase, so a focus on Send simply stays on Stop. The focus
 * hand-offs the spec's table names live here for the cases where a control
 * is disabled or removed under the person's focus: the composer disabled at
 * submission hands to Stop, a card control gone at resolution hands to
 * Stop, and a Stop turned back into a disabled Send at settlement, or a
 * pane control gone with the settlement (the outcome door), hands to the
 * enabled input. Focus anywhere else is never taken.
 *
 * Gives the form a second shape: where the instance offers a model choice,
 * the input sits above a footer row carrying the picker and the Send slot
 * (design page 04, option A). Where it does not, the form is exactly the
 * row that ships today.
 */
export function AssistantComposer({ phase, input, setInput, onSubmit, onStop, blocked, picker }: {
  phase: TurnPhase;
  input: string;
  setInput: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** The pane cannot take a message now for a reason other than the phase (a recovery door is offered). */
  blocked: boolean;
  /** The model and effort picker, where the instance offers a choice. */
  picker?: React.ReactNode;
}) {
  const working = composerWorking(phase);
  const stop = showsStop(phase);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const slotRef = useRef<HTMLButtonElement>(null);
  /** Where the person's focus last landed, as far as the hand-offs care.
   * A control disabled or removed under focus drops it to the body with
   * no blur, so the last landing is what decides. */
  const focused = useRef<FocusPlace>("elsewhere");
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      focused.current = focusPlace(target, target === inputRef.current, target === slotRef.current);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const previous = useRef(phase);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (before === phase) return;
    const active = document.activeElement;
    const dropped = active === null || active === document.body;
    if (!dropped) return;
    const landing = focusLanding(before, phase, focused.current);
    if (landing === "slot") slotRef.current?.focus();
    else if (landing === "input") inputRef.current?.focus();
  }, [phase]);
  const field = (
    <Textarea
      ref={inputRef}
      className={styles.input}
      {...{ [ASSISTANT_INPUT]: "" }}
      aria-label="Ask the assistant"
      value={input}
      placeholder={working ? "Working…" : "Ask the assistant…"}
      disabled={working || blocked}
      rows={2}
      onChange={(e) => setInput(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (!stop) onSubmit();
        }
      }}
    />
  );
  const slot = (
    <button
      ref={slotRef}
      type={stop ? "button" : "submit"}
      className={stop ? styles.stop : styles.send}
      data-slot-control={stop ? "stop" : "send"}
      disabled={!stop && (blocked || input.trim() === "")}
      onClick={stop ? onStop : undefined}
    >
      {stop ? <><StopIcon />Stop</> : "Send"}
    </button>
  );
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!stop) onSubmit();
  };
  if (!picker) return <form className={styles.inputRow} onSubmit={send}>{field}{slot}</form>;
  return (
    <form className={styles.inputColumn} onSubmit={send}>
      {field}
      <div className={styles.composerFoot}>
        {picker}
        <span className={styles.composerSpace} />
        {slot}
      </div>
    </form>
  );
}
