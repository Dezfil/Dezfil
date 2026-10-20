import { HomeScreen } from "@/components/home/HomeScreen";
import { requirePageScope } from "@/lib/auth/scope-page";
import { pictureBasemaps } from "@/lib/basemap-offer";
import { pictureRendererNotice } from "@/lib/pictures/notice";

// Every signed-in account's own Home; its parts are read in the browser as
// that account, so the page is drawn before any list answers. The
// instance's basemaps come with it, for the line crediting the pictures,
// and whether an administrator is told the pictures have no renderer.
export default async function HomePage() {
  const scope = await requirePageScope();
  return <HomeScreen pictureBasemaps={pictureBasemaps()} rendererNotice={pictureRendererNotice(scope)} />;
}
