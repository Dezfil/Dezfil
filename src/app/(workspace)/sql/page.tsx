import { SqlConsole } from "@/components/sql/SqlConsole";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { limits } from "@/lib/limits";
import { instanceDefaults } from "@/lib/settings/defaults";

/** The SQL console, with the assistant pane's layer-download doors under
 * the same control the builder gives them (one pane on three), handed the
 * instance's defaults as this page is served. */
export default function SqlPage() {
  return (
    <LayerDownloadControlProvider preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(limits.queryTimeoutMs)}>
      <ScreenDefaultsProvider defaults={instanceDefaults()}>
        <SqlConsole />
      </ScreenDefaultsProvider>
    </LayerDownloadControlProvider>
  );
}
