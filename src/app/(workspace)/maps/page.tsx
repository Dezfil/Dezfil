import { Suspense } from "react";
import { MapsScreen } from "@/components/MapsScreen";
import { requirePageScope } from "@/lib/auth/scope-page";

// The project scope lives in the list address; the live address reader
// needs the suspense boundary.
export default async function MapsPage() {
  await requirePageScope();
  return (
    <Suspense>
      <MapsScreen />
    </Suspense>
  );
}
