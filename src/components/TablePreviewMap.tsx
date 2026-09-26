"use client";

import { useEffect, useState } from "react";
import type { TableFeaturesResult } from "@/lib/table-service";
import { readApiError } from "./api";
import { featureCountReadout } from "./feature-readout";
import { ErrorNote } from "./ui/ErrorNote";
import { PreviewRefusalPlate } from "./PreviewRefusalPlate";
import styles from "./TablePreviewMap.module.css";
import { serverUnreachable } from "./failure-copy";
import { FeaturePreviewMap } from "./map/FeaturePreviewMap";

/**
 * The dataset detail's map preview: the table's features on a basemap,
 * fitted to their extent, with a truthful readout — including the "first N
 * of TOTAL" note when an over-cap table drew a capped subset.
 */
export function TablePreviewMap({
  name,
  crsAssumed,
  onSetGeometry,
}: {
  name: string;
  crsAssumed: boolean;
  /** The plate's Set geometry door (01), on a No geometry
   * dataset the API accepts; the page decides. */
  onSetGeometry?: () => void;
}) {
  const [result, setResult] = useState<TableFeaturesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let response: Response;
        try {
          response = await fetch(
            `/api/tables/${encodeURIComponent(name)}/features?sample=1`,
          );
        } catch {
          throw new Error(serverUnreachable("read the features"));
        }
        if (!response.ok) throw new Error(await readApiError(response));
        const body = (await response.json()) as TableFeaturesResult;
        if (!cancelled) {
          setResult(body);
          setError(null);
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error
              ? e.message
              : serverUnreachable("read the features"),
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, attempt]);

  const readout = result?.ok
    ? [
        featureCountReadout(result),
        result.geometryType ?? "",
        crsAssumed ? "WGS84 assumed" : "EPSG:4326",
      ].filter(Boolean)
    : null;

  return (
    <div className={styles.pane}>
      <FeaturePreviewMap
        geojson={
          result?.ok && result.geojson
            ? (result.geojson as GeoJSON.GeoJSON)
            : null
        }
      >
        {!result && !error && (
          <div className={styles.notice}>Reading features…</div>
        )}
        {error && (
          <div className={styles.errorWrap}>
            <ErrorNote
              message={error}
              onRetry={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            />
          </div>
        )}
        {/* The refusal is stated, not whispered: the same notice scrim
            the loading message uses, with the sentence on its own plate
            and a mark beside it. The sentence is the API's. */}
        {result && !result.ok && (
          <PreviewRefusalPlate reason={result.reason} onSetGeometry={onSetGeometry} />
        )}
        {readout && (
          <div className={styles.readout}>
            {readout.map((part, i) => (
              <span key={i} data-warn={i === 2 && crsAssumed ? "" : undefined}>
                {part}
              </span>
            ))}
          </div>
        )}
      </FeaturePreviewMap>
    </div>
  );
}
