import styles from "./WorkflowCanvas.module.css";

export interface CanvasNotice {
  text: string;
  tone?: "bad";
}

/**
 * The canvas's transient status and its persistent lock pill. A transient
 * stands above the pill while locked, so the action its message names never
 * disappears for the notice's hold time.
 */
export function CanvasNotices({
  notice,
  locked,
  onUnlock,
}: {
  notice: CanvasNotice | null;
  locked: boolean;
  onUnlock: () => void;
}) {
  const transient = notice ? (
    <p className={styles.notice} role="status" data-tone={notice.tone} data-canvas-notice>
      {notice.text}
    </p>
  ) : null;
  const lockPill = locked ? (
    <p className={styles.notice} role="status" data-canvas-notice={notice ? undefined : true} data-lock-pill>
      {/* One inline run inside the flex pill: a whitespace-only text
          node between flex items is not rendered, and the sentence once
          read "until youunlock.". */}
      <span>
        Canvas locked. Nothing moves or links until you{" "}
        <button type="button" className={styles.noticeAction} onClick={onUnlock} data-unlock>
          unlock
        </button>
        .
      </span>
    </p>
  ) : null;

  // The wrapper always mounts, so the pill's node (a live region holding
  // the unlock button) is never destroyed and re-announced at a transient's
  // boundary, and focus resting on unlock survives the notice.
  if (!transient && !lockPill) return null;
  return (
    <div className={styles.noticeStack} data-canvas-notice-stack>
      {transient}
      {lockPill}
    </div>
  );
}
