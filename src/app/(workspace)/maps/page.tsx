import { Suspense } from "react";
import { MapsScreen } from "@/components/MapsScreen";

// The project scope lives in the list address; the live address reader
// needs the suspense boundary.
export default function MapsPage() {
  return (
    <Suspense>
      <MapsScreen />
    </Suspense>
  );
}
