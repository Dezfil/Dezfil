import { notFound } from "next/navigation";

/** Any address deeper than a map's render page: the render root's plain
 * not-found page, never the workspace's. */
export default function RenderMissingPage(): never {
  notFound();
}
