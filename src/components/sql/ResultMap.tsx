"use client";

import { useMemo, useState } from "react";
import { formatCount } from "../api";
import { FeaturePreviewMap, type FeatureHover } from "../map/FeaturePreviewMap";
import { formatCell, isGeometryObject } from "./result-format";
import type { ResultColumn } from "./ResultTable";
import styles from "./SqlConsole.module.css";

/**
 * The result's map: the preview rows' first geometry column in result
 * order drawn over the basemap, named in the readout, with a hover
 * readout of the row's other columns; a geometry-bearing result with
 * nothing drawable says so instead of showing an empty sea.
 */
export function ResultMap({
  columns,
  rows,
  geometryColumn,
  rowCount,
}: {
  columns: readonly ResultColumn[];
  rows: readonly Record<string, unknown>[];
  geometryColumn: string;
  rowCount: number;
}) {
  const [hover, setHover] = useState<FeatureHover | null>(null);
  const geojson = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const g = row[geometryColumn];
      if (!isGeometryObject(g)) continue;
      const properties: Record<string, unknown> = { __row: i + 1 };
      let shown = 0;
      for (const c of columns) {
        if (c.name === geometryColumn || shown >= 6) continue;
        const v = row[c.name];
        properties[c.name] =
          v === null || v === undefined || typeof v === "object"
            ? formatCell(v).text
            : (v as string | number | boolean);
        shown += 1;
      }
      features.push({
        type: "Feature",
        geometry: g as GeoJSON.Geometry,
        properties,
      });
    }
    return { type: "FeatureCollection", features } as GeoJSON.FeatureCollection;
  }, [columns, rows, geometryColumn]);

  const drawn = geojson.features.length;
  return (
    <div className={styles.mapHost}>
      <FeaturePreviewMap geojson={drawn ? geojson : null} onHover={setHover}>
        {drawn === 0 && (
          <div className={styles.mapNotice}>
            <div>
              <div className={styles.resEmptyBig}>Nothing to draw</div>
              <div>
                {geometryColumn} is empty in every previewed row.
              </div>
            </div>
          </div>
        )}
        {drawn > 0 && (
          <div className={styles.mapReadout}>
            <span>
              {formatCount(drawn)}
              {rowCount > rows.length ? ` of ${formatCount(rowCount)}` : ""} features
            </span>
            <span>{geometryColumn}</span>
          </div>
        )}
        {hover && (
          <div
            className={styles.mapTip}
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            role="status"
          >
            {Object.entries(hover.properties)
              .filter(([k]) => k !== "__row")
              .slice(0, 4)
              .map(([k, v]) => (
                <div key={k}>
                  <span className={styles.mapTipKey}>{k}</span> {String(v)}
                </div>
              ))}
          </div>
        )}
      </FeaturePreviewMap>
    </div>
  );
}
