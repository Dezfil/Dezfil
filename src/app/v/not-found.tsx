import { PublishedNotFound } from "@/components/viewer/PublishedNotFound";

/** A published address that resolves to nothing, answered by the published
 * root itself: the published chrome at the view's default theme (the map's
 * own is unknown here), never the framework's bare page. */
export default function PublishedPageNotFound() {
  return (
    <div data-published-view data-view-theme="dark">
      <PublishedNotFound />
    </div>
  );
}
