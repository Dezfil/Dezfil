import { HomeScreen } from "@/components/home/HomeScreen";
import { requirePageScope } from "@/lib/auth/scope-page";
import { pictureBasemaps } from "@/lib/basemap-offer";

// Every signed-in account's own Home; its parts are read in the browser as
// that account, so the page is drawn before any list answers. The
// instance's basemaps come with it, for the line crediting the pictures.
export default async function HomePage() {
  await requirePageScope();
  return <HomeScreen pictureBasemaps={pictureBasemaps()} />;
}
