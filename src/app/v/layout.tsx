import { DOCUMENT_METADATA, DezfilDocument } from "../document";

export const metadata = DOCUMENT_METADATA;

/** The published viewer's root: a published page keeps Dezfil's default look
 * whoever opens it, and never follows the workspace theme (the page stamps
 * the map's own). */
export default function PublishedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <DezfilDocument themeBoot={false}>{children}</DezfilDocument>;
}
