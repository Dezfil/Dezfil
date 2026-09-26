import { TableDetailScreen } from "@/components/TableDetailScreen";

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
  const { name } = await params;
  const query = await searchParams;
  return (
    <TableDetailScreen
      name={name}
      openGeometry={query[OPEN_GEOMETRY_PARAM] === OPEN_GEOMETRY_VALUE}
    />
  );
}
