import { SqlConsole } from "@/components/sql/SqlConsole";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import { limits } from "@/lib/limits";

/** The SQL console, with the assistant pane's layer-download doors under
 * the same control the builder gives them (one pane on three). */
export default function SqlPage() {
  return (
    <LayerDownloadControlProvider preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(limits.queryTimeoutMs)}>
      <SqlConsole />
    </LayerDownloadControlProvider>
  );
}
