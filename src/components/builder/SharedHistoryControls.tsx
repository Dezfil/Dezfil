"use client";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { historyControl, type SharedHistory } from "./shared-history";
import { IconButton } from "../ui/IconButton";
import { UndoIcon, RedoIcon } from "../ui/icons";
import styles from "./MapBuilder.module.css";
export function SharedHistoryControls({ history, onUndo, onRedo, map, stale = false }: { history: SharedHistory; map?: MapWithLayers; stale?: boolean; onUndo: () => void; onRedo: () => void }) {
  return <>{(["undo", "redo"] as const).map(direction => <IconButton key={direction}
    className={`${styles.chromeBtn} ${styles.iconBtn}`} tone="chrome" hint {...historyControl(history, direction, map, stale)}
    shortcut={direction === "undo" ? "⌘Z / Ctrl+Z" : "⇧⌘Z / Ctrl+Y"}
    icon={direction === "undo" ? <UndoIcon /> : <RedoIcon />}
    onClick={direction === "undo" ? onUndo : onRedo} />)}</>;
}
