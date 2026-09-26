"use client";

import { DiagnoseIcon, ExplainIcon } from "../../ui/icons";
import type { EntryChip, EntryIcon } from "./entry-chips";
import styles from "./TalkingAbout.module.css";

const ICONS: Record<EntryIcon, () => React.ReactElement> = { explain: ExplainIcon, diagnose: DiagnoseIcon };

/** Two ways in above the input:
 * pressing one sends its words as the person's message. */
export function EntryChips({ chips, onPick, disabled }: { chips: EntryChip[]; onPick: (label: string) => void; disabled: boolean }) {
  if (chips.length === 0) return null;
  return (
    <div className={styles.entries} data-entry-chips>
      {chips.map((chip) => {
        const Icon = ICONS[chip.icon];
        return (
          <button key={chip.key} type="button" className={styles.entry} data-entry={chip.key} disabled={disabled} onClick={() => onPick(chip.label)}>
            <Icon />
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
