"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { coveredWidth, KEPT_SHAPE, PICTURE_SHAPE } from "@/lib/pictures/shapes";
import { MapPlaceholder } from "./gallery-icons";
import { mapCardImageAddress } from "./map-card-image";
import type { PictureCard } from "./picture-poll";
import { useFreshPicture } from "./PicturePoll";
import { useTheme } from "./theme";

interface Box { width: number; height: number }

/**
 * The box a strip fills, measured before the first paint and again
 * whenever it resizes: undefined until measured, null where it has no
 * size to measure.
 */
function useStripBox(inside: RefObject<Element | null>): Box | null | undefined {
  const [box, setBox] = useState<Box | null | undefined>(undefined);
  useLayoutEffect(() => {
    const strip = inside.current?.parentElement;
    const measurable = !!strip && typeof strip.getBoundingClientRect === "function";
    const measure = () => {
      const { width, height } = measurable && strip ? strip.getBoundingClientRect() : { width: 0, height: 0 };
      const next = width > 0 && height > 0 ? { width, height } : null;
      setBox((last) => (last && next && Math.abs(last.width - next.width) < 1 && Math.abs(last.height - next.height) < 1) || last === next ? last : next);
    };
    measure();
    if (!measurable || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [inside]);
  return box;
}

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
 *
 * The strip measures its box before the image is first drawn and offers
 * the picture's kept sizes with the width the picture covers there, so the
 * browser fetches the size this screen needs at its density. A box it
 * cannot measure gets the default picture.
 */
export function MapStrip({ map: listed }: { map: PictureCard }) {
  const { theme } = useTheme();
  const map = useFreshPicture(listed);
  const placeholder = useRef<SVGSVGElement>(null);
  const box = useStripBox(placeholder);
  const version = map.hasThumbnail ? map.pictureVersion : null;
  const src = version && box !== undefined ? mapCardImageAddress(map.id, version, theme) : null;
  const sized = src && box ? {
    srcSet: PICTURE_SHAPE.widths.map((width) => `${mapCardImageAddress(map.id, version!, theme, { shape: KEPT_SHAPE, width })} ${width}w`).join(", "),
    sizes: `${Math.ceil(coveredWidth(box))}px`,
  } : null;
  const address = sized ? sized.srcSet : src;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <MapPlaceholder ref={placeholder} />
      {src && failed !== address && (
        // Same-origin dynamic picture — next/image would only add an optimizer hop.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} {...(sized ?? {})} alt="" onError={() => setFailed(address)} />
      )}
    </>
  );
}
