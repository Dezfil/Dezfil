"use client";

import type { TableFeaturesResult } from "@/lib/table-service";
import { featureCountReadout } from "../feature-readout";
import { ErrorNote } from "../ui/ErrorNote";
import { FeaturePreviewMap } from "../map/FeaturePreviewMap";
import type { ReadState } from "./use-dataset-reads";
import styles from "./ResultsBand.module.css";

/** The readout's words: what the features read
 * warrants, the drawn count against the table's rows when sampled (the
 * count sentence shared with the shipped previews). */
export function readoutOf(r: TableFeaturesResult, crsAssumed: boolean): string[] {
  return [
    featureCountReadout(r),
    r.geometryType ?? "",
    crsAssumed ? "WGS84 assumed" : "",
  ].filter(Boolean);
}

/**
 * The Map tab: the dataset's features on the shared preview map, sampled
 * to the render cap when the table is larger, with the band's readout; a
 * spatial dataset with nothing drawable shows the empty map with a readout
 * of zero, never a refusal.
 */
export function MapTab({ features, crsAssumed, retry }: { features: ReadState<TableFeaturesResult> | null; crsAssumed: boolean; retry: () => void }) {
  const ok = features?.status === "read" && features.value.ok ? features.value : null;
  return (
    <div className={styles.mapHost} data-band-map>
      <FeaturePreviewMap geojson={ok ? (ok.geojson as GeoJSON.GeoJSON) : null}>
        {(!features || features.status === "reading") && <div className={styles.mapNotice}>Reading the features…</div>}
        {features?.status === "failed" && (
          <div className={styles.mapNotice} data-band-read-failed>
            <ErrorNote message={features.message} onRetry={retry} retryLabel="Retry" />
          </div>
        )}
        {features?.status === "read" && !features.value.ok && <div className={styles.mapNotice}>{features.value.reason}</div>}
        {ok && (
          <div className={styles.readout} data-band-readout data-drawn={ok.featureCount ?? 0} data-rows={ok.sampled ? (ok.totalCount ?? 0) : undefined}>
            {readoutOf(ok, crsAssumed).map((part, i) => (
              <span key={i} data-warn={part === "WGS84 assumed" ? "" : undefined}>
                {part}
              </span>
            ))}
          </div>
        )}
      </FeaturePreviewMap>
    </div>
  );
}
