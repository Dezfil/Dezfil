import { WorkflowScreen } from "@/components/WorkflowScreen";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import { limits } from "@/lib/limits";
import { requirePageScope } from "@/lib/auth/scope-page";
import { viewsOnly } from "../../standing";

/** A workflow's page: the frame the canvas fills,
 * with the assistant pane's layer-download doors under the same control
 * the builder gives them. A Viewer gets the canvas view-only. */
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const scope = await requirePageScope();
  const { id } = await params;
  return (
    <LayerDownloadControlProvider preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(limits.queryTimeoutMs)}>
      <WorkflowScreen id={id} viewOnly={viewsOnly(scope, "workflow", id)} />
    </LayerDownloadControlProvider>
  );
}
