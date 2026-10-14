import { SqlConsole } from "@/components/sql/SqlConsole";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { limits } from "@/lib/limits";
import { requirePageScope } from "@/lib/auth/scope-page";
import { instanceDefaults } from "@/lib/settings/defaults";

/** The SQL console, with the assistant pane's layer-download doors under
 * the same control the builder gives them (one pane on three), handed the
 * instance's defaults as this page is served. */
export default async function SqlPage() {
  await requirePageScope();
  return (
    <LayerDownloadControlProvider preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(limits.queryTimeoutMs)}>
      <ScreenDefaultsProvider defaults={instanceDefaults()}>
        <SqlConsole />
      </ScreenDefaultsProvider>
    </LayerDownloadControlProvider>
  );
}
