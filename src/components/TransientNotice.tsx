"use client";

import gallery from "./gallery.module.css";
import { ErrorNote } from "./ui/ErrorNote";
import type { NoticeTone } from "./use-transient-notice";

/** A page's transient notice in the look of its tone: a success in the
 * page's quiet notice, a warning or a failure as the application's failure
 * note, dismissable, since it stays until it is dismissed or replaced. */
export function TransientNotice({
  notice,
  tone,
  onDismiss,
}: {
  notice: string | null;
  tone: NoticeTone;
  onDismiss: () => void;
}) {
  if (notice === null) return null;
  if (tone === "ok") {
    return (
      <div className={gallery.notice} role="status">
        {notice}
      </div>
    );
  }
  return <ErrorNote tone={tone} message={notice} onDismiss={onDismiss} />;
}
