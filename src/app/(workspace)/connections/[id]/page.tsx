import { ConnectionDetail } from "@/components/connections/ConnectionDetail";

export default async function ConnectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConnectionDetail id={id} />;
}
