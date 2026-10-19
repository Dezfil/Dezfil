import { LogoMark } from "../LogoMark";
import styles from "./PublishedView.module.css";

/** A published address that resolves to nothing: the reader's documented
 * presentation, the same for a link taken down and one never issued. */
export function PublishedNotFound() {
  return (
    <div className={styles.splash}>
      <LogoMark size={30} />
      <h1 className={styles.notfoundTitle}>Map not found</h1>
      <p className={styles.notfoundText}>This link is no longer available.</p>
    </div>
  );
}
