"use client";

import { FlowIcon, LayersIcon, MapIcon, NodeIcon, PencilIcon, ResultIcon, RunIcon, WarnIcon } from "../../ui/icons";
import type { ChipIcon, TalkingChip } from "./talking-about";
import styles from "./TalkingAbout.module.css";

/**
 * The "talking about" row: under the pane's header, above the
 * transcript, a chip per subject the next message carries. Not controls:
 * nothing here is focusable or pressable.
 */

const ICONS: Record<ChipIcon, () => React.ReactElement> = {
  map: MapIcon,
  layer: LayersIcon,
  draft: PencilIcon,
  result: ResultIcon,
  warn: WarnIcon,
  flow: FlowIcon,
  node: NodeIcon,
  run: RunIcon,
};

export function TalkingAbout({ chips }: { chips: TalkingChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className={styles.row} data-talking-about aria-label="Talking about" role="group">
      {chips.map((chip) => {
        const Icon = ICONS[chip.icon];
        return (
          <span key={chip.key} className={styles.chip} data-chip={chip.key} data-tone={chip.tone}>
            <Icon />
            <span className={styles.label}>{chip.label}</span>
            <span className={chip.mono ? `${styles.value} ${styles.mono}` : styles.value}>{chip.value}</span>
          </span>
        );
      })}
    </div>
  );
}
