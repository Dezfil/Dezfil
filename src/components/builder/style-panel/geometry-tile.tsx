import type { GeometryKind } from "../render-data";
import { VizPathIcon, VizPolygonIcon, VizPointsIcon } from "../../ui/icons";

/** The geometry tile draws the features as they are; its face follows the
 * layer's geometry family (Point/Path/Polygon, one tile). */
export function geometryTile(kind: GeometryKind): {
  label: string;
  icon: React.ReactNode;
} {
  if (kind === "line") return { label: "Path", icon: <VizPathIcon /> };
  if (kind === "polygon")
    return { label: "Polygons", icon: <VizPolygonIcon /> };
  if (kind === "mixed") return { label: "Features", icon: <VizPointsIcon /> };
  return { label: "Points", icon: <VizPointsIcon /> };
}

