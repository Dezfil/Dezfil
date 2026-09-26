import { Suspense } from "react";
import { WorkflowsScreen } from "@/components/WorkflowsScreen";

// The project scope lives in the list address; the live address reader
// needs the suspense boundary.
export default function WorkflowsPage() {
  return (
    <Suspense>
      <WorkflowsScreen />
    </Suspense>
  );
}
