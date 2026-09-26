import type { AttributionLine } from "@/lib/basemap";
import styles from "./BasemapCredit.module.css";

/**
 * The active basemap's credit lines: dots between lines, links where a
 * line has one. Font and color come from the host — the builder's status
 * bar and the published footer both embed this.
 */
export function BasemapCredit({ lines }: { lines: AttributionLine[] }) {
  return (
    <span className={styles.credit}>
      {lines.map((line, i) => (
        <span key={line.label} className={styles.line}>
          {i > 0 && <span className={styles.dot}>·</span>}
          {line.href ? (
            <a href={line.href} target="_blank" rel="noreferrer">
              {line.label}
            </a>
          ) : (
            <span>{line.label}</span>
          )}
        </span>
      ))}
    </span>
  );
}
