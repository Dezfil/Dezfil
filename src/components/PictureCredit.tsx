"use client";

import { useMemo } from "react";
import type { AttributionLine } from "@/lib/basemap";
import {
  BUILT_IN_PICTURE_BASEMAPS,
  picturesCredit,
  type PictureBasemaps,
  type PicturedMap,
} from "@/lib/picture-credit";
import { BasemapCredit } from "./map/BasemapCredit";
import type { PictureCard } from "./picture-poll";
import { useFreshPictures } from "./PicturePoll";
import { useTheme } from "./theme";
import styles from "./PictureCredit.module.css";

/**
 * One quiet line for the map pictures on a page: the credits of the
 * basemaps they were drawn on, each a link where it has one, after a word
 * that says what it credits, since the open map's bare lines would read
 * as the page's own. A page's own line stands at its foot (`page`); a list
 * view carries it as its list card's foot row (`foot`). No picture on a
 * basemap with a credit, no line. A picture that lands while the page asks
 * its listing again is credited as it lands.
 */
export function PictureCredit({
  maps,
  basemaps = BUILT_IN_PICTURE_BASEMAPS,
  placement,
}: {
  /** The maps whose pictures the page shows. */
  maps: readonly (PicturedMap & PictureCard)[];
  /** The instance's basemaps, as the page was handed them. */
  basemaps?: PictureBasemaps;
  placement: "page" | "foot";
}) {
  const { theme } = useTheme();
  const shown = useFreshPictures(maps);
  const lines = useMemo(() => picturesCredit(shown, basemaps, theme), [shown, basemaps, theme]);
  return <PicturesCreditLine lines={lines} placement={placement} />;
}

/** The line itself, for a page that knows its pictures' credits without
 * asking the server for them. No credit, no line. */
export function PicturesCreditLine({
  lines,
  placement,
}: {
  lines: AttributionLine[];
  placement: "page" | "foot";
}) {
  if (lines.length === 0) return null;
  return (
    <p className={placement === "foot" ? styles.foot : styles.page} data-picture-credit={placement}>
      <span>Map previews:</span>
      <BasemapCredit lines={lines} />
    </p>
  );
}
