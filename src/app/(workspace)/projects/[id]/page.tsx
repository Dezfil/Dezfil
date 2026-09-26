import { ProjectHomeScreen } from "@/components/projects/ProjectHomeScreen";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectHomeScreen id={id} />;
}
