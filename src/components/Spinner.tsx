import styles from "./Spinner.module.css";

/** The shared loading indicator: every "loading…" text pairs
 * with a visible rotation so in-flight queries read as activity, not as a
 * stuck label. */
export function Spinner({ size = 13, tone = "accent" }: { size?: number; tone?: "accent" | "current" }) {
  return (
    <span
      className={styles.spin}
      data-tone={tone}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

export default Spinner;
