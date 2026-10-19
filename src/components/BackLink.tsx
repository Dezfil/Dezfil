import Link from "next/link";
import { IconBack } from "./gallery-icons";
import styles from "./BackLink.module.css";

/** The square back arrow before a page's title, leading to the list the
 * page belongs to: a dataset's to Data, a project's to Projects, a
 * connection's to Connections. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={styles.back} title={label} aria-label={label}>
      <IconBack />
    </Link>
  );
}
