"use client";

import { useState } from "react";
import type { MapOverview } from "./api";
import { MapPlaceholder } from "./gallery-icons";
import { mapCardImageAddress } from "./map-card-image";
import { useTheme } from "./theme";

/**
 * A map's picture: its latest snapshot when one exists, chart-paper
 * placeholder until then. The image is asked for only when the listing
 * says the map has one the viewer is served, so a map never captured sends
 * no request that could fail; the placeholder is always drawn underneath,
 * so an image that still fails never shows broken. Shared by the Maps
 * screen's cards and the destination dialog's cards; the host gives it a
 * sized `strip` box — the gallery's — to fill. The address carries the
 * viewer's theme, so every host follows a toggle with no reload; a failure
 * is remembered per address, so one theme's absent image cannot strand the
 * placeholder in the other.
 */
export function MapStrip({ map }: { map: MapOverview }) {
  const { theme } = useTheme();
  const src = mapCardImageAddress(map.id, map.updatedAt, theme);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <MapPlaceholder />
      {map.hasThumbnail && failed !== src && (
        // Same-origin dynamic PNG — next/image would only add an optimizer hop.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" onError={() => setFailed(src)} />
      )}
    </>
  );
}
