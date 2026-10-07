import { notFound } from "next/navigation";

/** Any address deeper than a published link: the published root answers it
 * with the published view's not-found page, to whoever asks. Without it the
 * workspace's catch-all would take the address behind the gate. */
export default function PublishedMissingPage(): never {
  notFound();
}
