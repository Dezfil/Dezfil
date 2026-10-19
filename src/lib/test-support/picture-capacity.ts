import { createMap } from "@/lib/map-service";
import { metadataDb } from "@/lib/metadata/db";
import type { AccountScope } from "@/lib/auth/scope";
import { saveThumbnail } from "@/lib/map-thumbnails";
import { pictureTarget, publishPicture } from "@/lib/pictures/publication";
import { requestPicture } from "@/lib/pictures/state";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { encodePng } from "@/lib/export/png-codec";
import { randomUUID } from "node:crypto";
import { insertLayer } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";

export type CapacityKind = "first" | "missing" | "mixed";
export interface CapacityMap { id: string; group: "missing" | "old" | "current"; pair: boolean; }
/** Offline fixture only: no picture service is started while the store is seeded. */
export async function seedPictureCapacity(scope: AccountScope, kind: CapacityKind, basemapUrl: string): Promise<CapacityMap[]> {
  const url = new URL(basemapUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/style.json") throw new Error("Capacity pictures require the loopback tile fixture.");
  const maps: CapacityMap[] = [], now = Date.now() - 60000;
  const png = encodePng({ width: 1, height: 1, rgba: new Uint8Array([28, 79, 64, 255]) });
  for (let i = 0; i < (kind === "first" ? 20 : 300); i++) {
    const group = kind !== "mixed" || i < 100 ? "missing" : i < 200 ? "old" : "current";
    const pair = i % 2 === 1;
    const map = createMap(scope, `Capacity ${group} ${i}`);
    // Old pictures are newer than missing ones: only the work priority, not
    // the edit clock, can put the missing cohort first.
    const updatedAt = new Date(now + i).toISOString();
    metadataDb().prepare("UPDATE maps SET basemap = ?, custom_basemap = ?, view_lng = 13.4, view_lat = 52.5, view_zoom = 12, view_pitch = 0, view_bearing = 0, updated_at = ? WHERE id = ?")
      .run(pair ? null : "light", pair ? null : JSON.stringify({ url: basemapUrl, name: "Loopback", attribution: [{ label: "Loopback fixture" }] }), updatedAt, map.id);
    // A constant spatial query still runs through the layer API and draws a
    // mark at the saved centre, without sharing a dataset between workloads.
    insertLayer({ id: randomUUID(), mapId: map.id, name: "Centre point", sql: "SELECT ST_Point(13.4, 52.5) AS geom",
      style: defaultStyle("POINT", 0), visible: true, tooltip: null, popup: null, publishedFields: null,
      inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null,
      ordinal: 0, createdAt: updatedAt, updatedAt });
    if (group === "old") await saveThumbnail(scope, map.id, png);
    if (group === "current") {
      const target = pictureTarget(scope, map.id), state = requestPicture(map.id, target.digest, now);
      await publishPicture(scope, target, state.requestedGeneration, { light: png, ...(pair ? { dark: png } : {}) }, NO_INPUTS);
    }
    maps.push({ id: map.id, group, pair });
  }
  return maps;
}
