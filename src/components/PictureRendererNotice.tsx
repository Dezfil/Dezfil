import Link from "next/link";
import styles from "./PictureRendererNotice.module.css";

/** Where the System tab names the renderer's standing and its setting. */
export const RENDERER_SETTINGS_HREF = "/settings/system#sys-renderer";

/**
 * The one line a page of map cards carries for administrators while the
 * instance has no renderer for map pictures: every card stays the same
 * paper, so the page says once why none is drawn and where to set one.
 * The page decides `shown` as it is served (an administrator, the System
 * read's standing); nobody else is handed it.
 */
export function PictureRendererNotice({ shown }: { shown: boolean | undefined }) {
  if (!shown) return null;
  return (
    <p className={styles.notice} data-renderer-notice>
      <span>
        No map pictures: this instance has no renderer.{" "}
        <Link href={RENDERER_SETTINGS_HREF}>Settings · System</Link> says how to set one.
      </span>
    </p>
  );
}
