"use client";
import type { MouseEvent } from "react";
import { LOCATOR_HEIGHT, LOCATOR_WIDTH, locatorPaths, pointAt, viewMark } from "./world-locator";
import styles from "./MapsTab.module.css";

const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * The world beside a new map's starting view: the area a new map shows
 * marked on it, and a click picking the place under the pointer as the
 * new latitude and longitude. It repeats the three fields beside it for a
 * pointer, so assistive technology, which has the fields, does not meet it.
 */
export function WorldLocator({ latitude, longitude, zoom, onPick }: {
  latitude: number;
  longitude: number;
  zoom: number;
  onPick: (place: { latitude: number; longitude: number }) => void;
}) {
  const { land, seas } = locatorPaths();
  const mark = viewMark(latitude, longitude, zoom);
  const pick = (event: MouseEvent<HTMLSpanElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    onPick(pointAt((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height, zoom));
  };
  return <span className={styles.locator} data-locator="" aria-hidden="true" onClick={pick}>
    <svg viewBox={`0 0 ${LOCATOR_WIDTH} ${LOCATOR_HEIGHT}`} preserveAspectRatio="xMidYMid slice">
      <rect className={styles.sea} width={LOCATOR_WIDTH} height={LOCATOR_HEIGHT} />
      <path className={styles.land} d={land} />
      <path className={styles.sea} d={seas} />
      {mark.kind === "area"
        ? <rect className={styles.mark} data-view="area" x={tenth(mark.x)} y={tenth(mark.y)} width={tenth(mark.width)} height={tenth(mark.height)} rx="2" />
        : <>
          <circle className={styles.mark} data-view="point" cx={tenth(mark.x)} cy={tenth(mark.y)} r="5" />
          <circle className={styles.dot} cx={tenth(mark.x)} cy={tenth(mark.y)} r="1.6" />
        </>}
    </svg>
  </span>;
}
