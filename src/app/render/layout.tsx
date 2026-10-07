import { DOCUMENT_METADATA, DezfilDocument } from "../document";

export const metadata = DOCUMENT_METADATA;

/** The render route's root: the server's image of a map keeps Dezfil's default
 * look, whoever asked for it. */
export default function RenderLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <DezfilDocument>{children}</DezfilDocument>;
}
