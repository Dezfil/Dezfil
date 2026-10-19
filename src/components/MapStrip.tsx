"use client";

import { useState } from "react";
import { MapPlaceholder } from "./gallery-icons";
import { mapCardImageAddress } from "./map-card-image";
import type { PictureCard } from "./picture-poll";
import { useFreshPicture } from "./PicturePoll";
import { useTheme } from "./theme";

/**
 * A map's picture: the last picture the reader is served, chart-paper
 * placeholder when there is none. The image is asked for by the listing's
 * picture version, and only when the listing says the reader is served
 * one, so a map without a picture sends no request that could fail; while
 * newer work waits or has failed, the version is still the last picture's
 * and that picture stays. The placeholder is always drawn underneath, so
 * an image that fails to load never shows broken. Shared by every card
 * host; the host gives it a sized `strip` box to fill, and a host that
 * asks its listing again while cards wait hands it the freshest picture
 * without a reload. The address carries the viewer's theme, so every host
 * follows a toggle with no reload; a failure is remembered per address, so
 * one theme's absent image cannot strand the placeholder in the other,
 * and a new version asks again.
 */
export function MapStrip({ map: listed }: { map: PictureCard }) {
  const { theme } = useTheme();
  const map = useFreshPicture(listed);
  const version = map.hasThumbnail ? map.pictureVersion : null;
  const src = version ? mapCardImageAddress(map.id, version, theme) : null;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <MapPlaceholder />
      {src && failed !== src && (
        // Same-origin dynamic PNG — next/image would only add an optimizer hop.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" onError={() => setFailed(src)} />
      )}
    </>
  );
}
