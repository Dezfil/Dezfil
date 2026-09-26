import type { CSSProperties } from "react";
import styles from "./GradientRamp.module.css";

/**
 * A gradient strip rendered edge-safe: the gradient itself paints on an
 * inner element wider than the visible box (see the module CSS). Every
 * continuous ramp render — palette picker, domain brush, legends — goes
 * through here so none of them can bleed at the ends.
 */
export function GradientRamp({
  className,
  gradient,
  style,
  ...rest
}: {
  className?: string;
  /** A CSS gradient image, e.g. `linear-gradient(90deg, …)`. */
  gradient: string;
  style?: CSSProperties;
} & Record<`data-${string}`, string | boolean>) {
  return (
    <span
      className={className ? `${styles.crop} ${className}` : styles.crop}
      aria-hidden
      style={style}
      {...rest}
    >
      <i className={styles.paint} style={{ background: gradient }} />
    </span>
  );
}
