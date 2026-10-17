import { notFound } from "next/navigation";
import { TableDetailScreen } from "@/components/TableDetailScreen";
import { ApiError } from "@/lib/api/errors";
import { requirePageScope } from "@/lib/auth/scope-page";
import { addressDataset } from "@/lib/dataset-address";

/** The open-with-panel address: `?geometry=set` opens the
 * set-geometry panel on mount; the builder's catalog door uses it. */
export const OPEN_GEOMETRY_PARAM = "geometry";
export const OPEN_GEOMETRY_VALUE = "set";

export default async function TablePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ geometry?: string | string[] }>;
}) {
  const scope = await requirePageScope();
  const { name } = await params;
  // A dataset the reader does not reach is not found, as a missing one is.
  try {
    addressDataset(scope, name);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const query = await searchParams;
  return (
    <TableDetailScreen
      name={name}
      openGeometry={query[OPEN_GEOMETRY_PARAM] === OPEN_GEOMETRY_VALUE}
    />
  );
}
