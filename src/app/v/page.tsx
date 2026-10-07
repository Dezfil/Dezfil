import { notFound } from "next/navigation";

/** The published root's own address names no published map: answered by the
 * published view's not-found page, to whoever asks, never the workspace's. */
export default function PublishedRootPage(): never {
  notFound();
}
