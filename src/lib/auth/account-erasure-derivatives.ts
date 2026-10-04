import type { Database } from "better-sqlite3";
import { requireDeletingAccount } from "@/lib/metadata/account-erasure";
import { eraseThumbnailArtifacts } from "@/lib/thumbnail-erasure";
import { layersWithEvidenceOf, runningLayersOf } from "@/lib/tiles/evidence";
import { eraseTileArtifacts, tileBuildsSettled } from "@/lib/tiles/build";
interface DerivativeCapture { maps: string[]; layers: { id: string; mapId: string }[]; datasets: { id: string }[] }
export async function eraseAccountDerivatives(accountId: string, captured: DerivativeCapture, db: Database): Promise<void> {
  db.transaction(() => requireDeletingAccount(accountId, db)).immediate();
  const datasets = captured.datasets.map(d => d.id);
  const layers = () => [...new Set([...captured.layers.map(l => l.id), ...datasets.flatMap(id => [...layersWithEvidenceOf(id), ...runningLayersOf(id)])])];
  // Known builds are fenced first. Wait unknown-input builds through their
  // final evidence, then scan again before deleting any evidence.
  await eraseTileArtifacts(layers());
  await tileBuildsSettled();
  await eraseTileArtifacts(layers());
  await eraseThumbnailArtifacts(captured.maps, datasets);
}
