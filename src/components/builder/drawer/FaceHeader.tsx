"use client";

import styles from "./FaceHeader.module.css";
import { XIcon } from "../../ui/icons";
import { OperationGlyph } from "../../ui/operation-icons";

/** The operation's mark and the group whose hue it wears: the drawing the
 * catalog already draws beside the same name (the two-tone set). */
export type FaceMark = { symbol: string; group: string };

/**
 * One header row per drawer face (tools; a path of segments): where a
 * face has somewhere to return to, the word *Tools* stands as the way
 * back, quiet and pressable, and the face's own name follows it
 * underlined and in the accent; where it has nowhere to return to, the
 * single segment is the face's own name. The dismissal sits at the top
 * right on both.
 *
 * **A path, not a tab strip.** The look is the inspector strip's, the
 * semantics are not: only the return is a control, and the segment that
 * names where you are stays a heading, so nothing here claims to switch
 * sibling panels. The assistant pane shares this row with `segments`
 * off: its title keeps the plain presentation it had, no underline and
 * no segment box (and the spec's out-of-scope line).
 *
 * The glyph before a tool's name is decoration, hidden from assistive
 * technology so the heading's accessible name stays the name alone. The
 * design round advised against it (its group hue beside the accent
 * title); it was chosen in the field, and the field round judges the pair.
 */
export function FaceHeader({
  title,
  mark,
  onBack,
  onDismiss,
  dismissLabel = "Close the drawer",
  drawerDismiss = true,
  segments = true,
  actions,
}: {
  title: string;
  /** Present where the face names a tool: its glyph precedes the name. */
  mark?: FaceMark;
  /** Present where the face has the tools list to return to. */
  onBack?: () => void;
  onDismiss: () => void;
  /** The dismiss control's accessible name — the assistant pane names
   * its own ("Close assistant"); drawer faces keep the default. */
  dismissLabel?: string;
  /** `data-drawer-dismiss` marks THE drawer's dismiss; the assistant
   * pane reuses this header but is not the drawer, and must not double
   * that hook (its mounted-while-closed close broke strict locators). */
  drawerDismiss?: boolean;
  /** The drawer's faces are a path of segments; the assistant pane is
   * not, and keeps its plain title. */
  segments?: boolean;
  /** A face's own header action, standing at the dismissal's weight just
   * before it (item 6: the assistant pane's clear control). */
  actions?: React.ReactNode;
}) {
  return (
    <div className={segments ? `${styles.head} ${styles.path}` : styles.head}>
      {onBack && (
        <button
          type="button"
          className={styles.segment}
          data-face-back
          aria-label="Back to the tools"
          onClick={onBack}
        >
          Tools
        </button>
      )}
      {!segments && <h3 className={styles.title}>{title}</h3>}
      {segments && (
      <h3 className={styles.current}>
        {mark && (
          <span
            className={styles.mark}
            data-face-glyph
            data-grp={mark.group}
            aria-hidden="true"
          >
            <OperationGlyph symbol={mark.symbol} />
          </span>
        )}
        <span className={styles.name} data-face-name>
          {title}
        </span>
      </h3>
      )}
      {actions}
      <button
        type="button"
        className={styles.dismiss}
        data-drawer-dismiss={drawerDismiss ? "true" : undefined}
        aria-label={dismissLabel}
        onClick={onDismiss}
      >
        <XIcon />
      </button>
    </div>
  );
}

/** The face's own scroll region, under its fixed header. */
export function FaceBody({ children }: { children: React.ReactNode }) {
  return <div className={styles.faceBody}>{children}</div>;
}
