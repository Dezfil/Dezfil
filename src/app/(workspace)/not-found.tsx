import Link from "next/link";
import gallery from "@/components/gallery.module.css";

/** An address the workspace has no page for, or a page the reader cannot
 * reach: said inside the shell, so the way back is where it always is. */
export default function WorkspaceNotFound() {
  return (
    <div className={gallery.heading}>
      <div>
        <h1>Page not found</h1>
        <p className={gallery.subLine}>Nothing is at this address.</p>
      </div>
      <Link className={gallery.primary} href="/">Go to Home</Link>
    </div>
  );
}
