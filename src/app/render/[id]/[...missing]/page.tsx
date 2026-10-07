import { notFound } from "next/navigation";

/** Any address deeper than a map's render page: the render root's plain
 * not-found page, never the workspace's catch-all. */
export default function RenderMissingPage(): never {
  notFound();
}
