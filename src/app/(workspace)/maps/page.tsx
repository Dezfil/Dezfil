import { Suspense } from "react";
import { MapsScreen } from "@/components/MapsScreen";
import { requirePageScope } from "@/lib/auth/scope-page";
import { pictureBasemaps } from "@/lib/basemap-offer";
import { pictureRendererNotice } from "@/lib/pictures/notice";

// The project scope lives in the list address; the live address reader
// needs the suspense boundary. The instance's basemaps are read as the page
// is served, for the line that credits the pictures' basemaps, and so is
// whether an administrator is told the pictures have no renderer.
export default async function MapsPage() {
  const scope = await requirePageScope();
  return (
    <Suspense>
      <MapsScreen pictureBasemaps={pictureBasemaps()} rendererNotice={pictureRendererNotice(scope)} />
    </Suspense>
  );
}
