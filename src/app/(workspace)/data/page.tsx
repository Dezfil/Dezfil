import { Suspense } from "react";
import { TablesScreen } from "@/components/TablesScreen";

export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; connection?: string }>;
}) {
  const query = await searchParams;
  const connection =
    query.source === "postgis" && typeof query.connection === "string"
      ? query.connection
      : null;
  // The project scope lives in the list address; the live address
  // reader needs the suspense boundary. The import-door values stay
  // server-parsed exactly as before.
  return (
    <Suspense>
      <TablesScreen initialPostgisConnectionId={connection} />
    </Suspense>
  );
}
