import { PublishedView } from "@/components/viewer/PublishedView";
import { availableBasemaps, basemapUrl } from "@/lib/basemap";
import { getPublishedThemeByToken } from "@/lib/metadata/maps";

export default async function PublishedPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { token } = await params;
  // The generated embed snippet marks its URL and the marked view renders
  // the reduced control set. Read server-side and handed down, per the
  // house rule at (workspace)/maps/[id] — a client-side URL sniff races
  // the router's history commit.
  const { embed } = await searchParams;
  // data-published-view pins the published chrome scope (earlier typefaces,
  // page texture) independent of light/dark; data-view-theme carries the
  // authored default, server-stamped so the first paint is right. That
  // stamp is the whole story — the reader's switch is load-local, so there
  // is no pre-paint script to overlay a remembered choice, and no hydration
  // mismatch to suppress. Unknown tokens read dark; the client fetch owns
  // the 404 presentation.
  const authored = getPublishedThemeByToken(token) ?? "dark";
  return (
    <div data-published-view data-view-theme={authored}>
      <PublishedView
        token={token}
        basemapUrl={basemapUrl()}
        basemaps={availableBasemaps()}
        embedded={embed === "1"}
      />
    </div>
  );
}
