import { DOCUMENT_METADATA, DezfilDocument } from "../document";

export const metadata = DOCUMENT_METADATA;

/** The entry screens' root: sign-in, setup and accepting an invitation are
 * reached before anyone is known, so they always show Dezfil's default look. */
export default function EntryLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <DezfilDocument>{children}</DezfilDocument>;
}
