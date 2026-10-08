import { canReach } from "@/lib/auth/reach";
import { notFound } from "next/navigation";
import { WorkflowScreen } from "@/components/WorkflowScreen";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import { limits } from "@/lib/limits";
import { requirePageScope } from "@/lib/auth/scope-page";
import { instanceDefaults } from "@/lib/settings/defaults";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { runsWorkflow, viewsOnly } from "../../standing";

/** A workflow's page: the frame the canvas fills,
 * with the assistant pane's layer-download doors under the same control
 * the builder gives them. Whoever may not change it gets the canvas
 * view-only, with its runs kept for whoever may run it. The canvas is
 * handed the instance's defaults as this page is served. */
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const scope = await requirePageScope();
  const { id } = await params;
  if (!canReach(scope, "workflow", id)) notFound();
  return (
    <LayerDownloadControlProvider preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(limits.queryTimeoutMs)}>
      <ScreenDefaultsProvider defaults={instanceDefaults()}>
        <WorkflowScreen id={id} viewOnly={viewsOnly(scope, "workflow", id)} runs={runsWorkflow(scope, id)} />
      </ScreenDefaultsProvider>
    </LayerDownloadControlProvider>
  );
}
