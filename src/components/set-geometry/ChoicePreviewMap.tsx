"use client";

import type { GeometryRecord } from "@/lib/geometry-evidence";
import { FeaturePreviewMap, featureBounds } from "../map/FeaturePreviewMap";
import { InfoIcon } from "../ui/icons";
import mapStyles from "../TablePreviewMap.module.css";
import { mapNotice, readout } from "./derivations";
import type { GeometryPreview } from "./types";
import { WorldInset } from "./WorldInset";

/** The preview's drawable features: the sample rows that read, as the API returned them. */
export function sampleCollection(answer: GeometryPreview): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: answer.sample.features.features.filter((f) => f.geometry !== null) as GeoJSON.Feature[],
  };
}

/** Where the fit sits: the centre of the drawn features' extent. */
export function fitCenter(collection: GeoJSON.FeatureCollection): [number, number] | null {
  const bounds = featureBounds(collection);
  if (!bounds) return null;
  const round = (v: number) => Number(v.toFixed(6));
  return [round((bounds[0][0] + bounds[1][0]) / 2), round((bounds[0][1] + bounds[1][1]) / 2)];
}

/**
 * The page's Map preview while the panel is open: the feature
 * preview primitive over the API's sample, refitted on every answer, with
 * the drawn readout, the map's notice in the plate's place, and the world
 * inset marking where the fit sits. It draws the answer it is given and
 * nothing else, its readout included: the last answer stays, labelled as
 * it was read, while the next is in flight.
 */
export function ChoicePreviewMap({ answer, record }: {
  answer: GeometryPreview;
  record: GeometryRecord | null;
}) {
  const collection = sampleCollection(answer);
  const center = fitCenter(collection);
  const notice = mapNotice(answer);
  const parts = readout(answer, record);
  return (
    <div className={mapStyles.pane} data-choice-preview="">
      <FeaturePreviewMap geojson={collection.features.length ? collection : null}>
        {notice && (
          <div className={mapStyles.notice} data-preview-refusal="">
            <p className={mapStyles.refusal}>
              <InfoIcon />
              <span>{notice}</span>
            </p>
          </div>
        )}
        {parts && (
          <div className={mapStyles.readout} data-choice-readout="">
            {parts.map((part, i) => (
              <span key={i}>{part}</span>
            ))}
          </div>
        )}
        {center && <WorldInset center={center} />}
      </FeaturePreviewMap>
    </div>
  );
}
