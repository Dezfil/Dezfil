import { headers } from "next/headers";
import { ItemNotFound } from "@/components/ItemNotFound";
import { ABSENT_KIND_HEADER, readAbsentKind } from "@/lib/absent-kind";
import WorkspaceLayout from "./(workspace)/layout";
import WorkspaceNotFound from "./(workspace)/not-found";
import { DOCUMENT_METADATA } from "./document";

export const metadata = DOCUMENT_METADATA;

/**
 * Any address no page answers, a page's or an API's: the framework's own
 * not-found, which sets the 404 status before anything renders, drawn as
 * the workspace's not-found page inside the shell with the person's look on
 * the root. A catch-all page inside the workspace could not do this: the
 * workspace holds its pages out of the server render until the browser has
 * confirmed the session, so a page's not-found never reached the render
 * that decides the status, and the address answered 200. For the same
 * reason the gate serves a page that shows one map, workflow, project,
 * dataset or template the person reaches nothing at as an address no page
 * answers, so it ends here too, and says which kind it was. The published and render roots keep
 * catch-alls of their own, which hold nothing back, so their addresses get
 * their own not-found pages with the same 404. An anonymous request never
 * reaches this: the gate answers it first.
 */
export default async function GlobalNotFound() {
  const kind = readAbsentKind((await headers()).get(ABSENT_KIND_HEADER));
  return (
    <WorkspaceLayout>
      {kind ? <ItemNotFound kind={kind} /> : <WorkspaceNotFound />}
    </WorkspaceLayout>
  );
}
