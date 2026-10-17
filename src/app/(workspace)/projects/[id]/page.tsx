import { notFound } from "next/navigation";
import { ProjectHomeScreen } from "@/components/projects/ProjectHomeScreen";
import { requirePageScope } from "@/lib/auth/scope-page";
import { canReach, mayFileInto } from "@/lib/auth/reach";
import { pictureBasemaps } from "@/lib/basemap-offer";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const scope = await requirePageScope();
  const { id } = await params;
  if (!canReach(scope, "project", id)) notFound();
  // Whether the home offers Add to project is the reach kernel's filing
  // answer, not the reader's role: an Editor of a project whose owner is
  // deactivated reads it, and a frozen project accepts nothing new. The
  // instance's basemaps come with it, for the line crediting the pictures.
  return <ProjectHomeScreen id={id} files={mayFileInto(scope, id)} pictureBasemaps={pictureBasemaps()} />;
}
