import { ProjectsScreen } from "@/components/ProjectsScreen";
import { requirePageScope } from "@/lib/auth/scope-page";
import { pictureRendererNotice } from "@/lib/pictures/notice";

// The projects are read in the browser; whether an administrator is told
// the pictures have no renderer is read as the page is served.
export default async function ProjectsPage() {
  const scope = await requirePageScope();
  return <ProjectsScreen rendererNotice={pictureRendererNotice(scope)} />;
}
