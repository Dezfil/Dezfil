import { ProjectHomeScreen } from "@/components/projects/ProjectHomeScreen";
import { requirePageScope } from "@/lib/auth/scope-page";
import { mayFileInto } from "@/lib/auth/reach";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const scope = await requirePageScope();
  const { id } = await params;
  // Whether the home offers Add to project is the reach kernel's filing
  // answer, not the reader's role: an Editor of a project whose owner is
  // deactivated reads it, and a frozen project accepts nothing new.
  return <ProjectHomeScreen id={id} files={mayFileInto(scope, id)} />;
}
