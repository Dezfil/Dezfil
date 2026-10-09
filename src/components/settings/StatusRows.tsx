"use client";
import { useState } from "react";
import { partTestWords, type Part, type PartTestAnswer } from "@/lib/system/part-test-answer";
import type { InstanceRead } from "./instance-read";
import { TestLine } from "./ServiceChecks";
import { SettingRow, ValueText } from "./SettingRows";
import { partMeta, partState, STATUS_ROWS, type Health } from "./status-table";
import styles from "./SystemTab.module.css";

/**
 * Status's part rows: each part with what is known of it under its label,
 * its state, and its Test with the answer line. The state follows the
 * Test's answer where the answer decides it; `onAnswered` lets the card
 * read the parts again, so what a Test made known (the engine's
 * extensions, the tile builder's version) shows too.
 */

/** A part's state: a dot and its words. */
export function State({ state, children }: { state: "on" | "off" | "danger"; children: string }) {
  return <span className={styles.state} data-state={state}>{children}</span>;
}

export function PartRow({ part, read, health, onAnswered }: {
  part: Part;
  read: Pick<InstanceRead, "settings" | "parts">;
  health: Health;
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = useState<PartTestAnswer | null>(null);
  const row = STATUS_ROWS[part], meta = partMeta(part, read), state = partState(part, read.parts, health, answer);
  return <SettingRow id={row.id} label={row.label} meta={meta && (meta.mono ? <ValueText mono>{meta.text}</ValueText> : meta.text)}>
    <span className={styles.stateCell}>
      {state.tone === "checking" ? <ValueText muted>{state.text}</ValueText> : <State state={state.tone}>{state.text}</State>}
    </span>
    <TestLine<PartTestAnswer> path={`/api/instance/parts/${part}/test`} words={partTestWords}
      onAnswer={next => { setAnswer(next); onAnswered(); }} />
  </SettingRow>;
}
