import styles from "../AssistantPanel.module.css";

/** The thinking indicator: three
 * pulsing dots in the reply's own place, before the first action or word
 * and while the first text is awaited after actions settle. Under reduced
 * motion the dots stand still and stay visible. Its name is for the
 * status region's reader; the dots themselves say nothing. */
export function ThinkingDots() {
  return (
    <div className={styles.thinkingSlot} data-thinking>
      <span className={styles.thinking} role="img" aria-label="Thinking">
        <i /><i /><i />
      </span>
    </div>
  );
}
