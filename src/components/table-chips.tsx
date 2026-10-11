"use client";

import type { DataTable } from "./api";
import { classOfTable } from "./geometry-class";
import { GeometryIcon, geometryKind } from "./gallery-icons";
import { CaretIcon } from "./ui/icons";
import { templateSentence } from "./template-sentence";
import gallery from "./gallery.module.css";

/**
 * Whether a table carries a stored import that can be re-run. A derived
 * table does not: it was produced by an operation, and re-running it is
 * that operation's affair, not an import refresh. One home for the rule so
 * a new source kind is decided once rather than in each `source!==
 * "upload"` comparison it would otherwise fall through.
 */
export function isRefreshableImport(table: {
  source: DataTable["source"];
}): boolean {
  return (
    table.source !== "upload" &&
    table.source !== "operation" &&
    table.source !== "sketch" &&
    table.source !== "template"
  );
}

/** Badge copy per provenance source. */
export function sourceLabel(table: DataTable): string {
  switch (table.source) {
    case "url":
      return "URL import";
    case "overture":
      return "Overture Maps";
    case "osm":
      return "OpenStreetMap";
    case "postgis":
      return "PostGIS";
    case "operation":
      return "Operation result";
    case "sketch":
      return "Drawn on a map";
    case "template":
      return "From a template";
    default:
      return "File upload";
  }
}

export function sourceTitle(table: DataTable): string {
  switch (table.source) {
    case "url":
      return `Imported from ${String(table.sourceParams?.url ?? "a URL")}`;
    case "overture":
      return `Overture ${String(table.sourceParams?.theme ?? "")} · release ${String(table.sourceParams?.release ?? "?")}`;
    case "osm": {
      const selectors = table.sourceParams?.selectors;
      return Array.isArray(selectors)
        ? `Overpass query: ${selectors.map(String).join(", ")}. Refresh re-runs the whole import group`
        : "Custom Overpass query. Refresh re-runs the whole import group";
    }
    case "postgis":
      return `Snapshot of ${String(table.sourceParams?.schema ?? "")}.${String(table.sourceParams?.table ?? "")} from "${String(table.sourceParams?.connectionName ?? "?")}"`;
    case "operation": {
      // never "uploaded". A derived table is described by the operation that
      // produced it, and by the tables that operation read.
      const op = String(table.sourceParams?.operation ?? "an operation");
      const inputs = table.sourceParams?.inputs;
      const names = Array.isArray(inputs)
        ? inputs
            .map((i) =>
              typeof i === "object" && i !== null && "name" in i
                ? String((i as { name: unknown }).name)
                : String(i),
            )
            .filter(Boolean)
        : [];
      return names.length
        ? `Produced by ${op} from ${names.join(", ")}`
        : `Produced by ${op}`;
    }
    case "sketch": {
      // a sketch belongs to the map it was drawn on; the params carry
      // the map's name for exactly this sentence.
      const mapName = table.sourceParams?.mapName;
      return typeof mapName === "string" && mapName
        ? `Drawn on "${mapName}"`
        : "Drawn on a map";
    }
    case "template":
      return templateSentence(table.sourceParams);
    default:
      return `Uploaded as ${table.sourceFilename ?? "a file"}`;
  }
}

export const SOURCE_COLORS: Record<DataTable["source"], string> = {
  upload: "var(--accent)",
  url: "#2f66cc",
  overture: "#1e6ce0",
  osm: "#76a723",
  postgis: "#4d84ad",
  operation: "var(--source-operation)",
  sketch: "#a84a8f",
  template: "#9a6b1f",
};

export function SourceChip({ table }: { table: DataTable }) {
  return (
    <span
      className={gallery.chip}
      style={{ "--dot": SOURCE_COLORS[table.source] } as React.CSSProperties}
      title={sourceTitle(table)}
    >
      <i />
      {sourceLabel(table)}
    </span>
  );
}

export function GeometryChip({ table }: { table: DataTable }) {
  const kind = geometryKind(table.geometryType, table.geometryColumn);
  const label = geometryChipLabel(table);
  return (
    <span
      className={gallery.chipGeo}
      title={
        kind === "none"
          ? "non-spatial"
          : table.geometryType || "geometry class unknown"
      }
    >
      <GeometryIcon kind={kind} />
      {label}
    </span>
  );
}

export function geometryChipLabel(
  table: Pick<DataTable, "geometryType" | "geometryColumn">,
): string {
  const kind = geometryKind(table.geometryType, table.geometryColumn);
  const geometryClass = classOfTable(table);
  if (geometryClass === "unknown") return "Geometry";
  if (geometryClass === "none") return "No geometry";
  return (
    kind === "point"
      ? "Points"
      : kind === "line"
        ? "Lines"
        : kind === "polygon"
          ? "Polygons"
          : kind === "mixed"
            ? "Mixed"
            : "Geometry"
  );
}

/** The door variant's drawn tooltip (04): the shipped sentence
 * plus the one line that says the chip now opens something. */
export const CRS_DOOR_TIP = "The file declared no CRS. WGS 84 was assumed.";
export const CRS_DOOR_TIP_ACTION = "Click to choose the projection.";

/** The assumed-CRS chip. On the dataset page alone it is a door:
 * given `onOpen`, it carries the caret the chips use for a door,
 * shows the drawn tooltip on hover and focus, and opens the panel with the
 * projection field marked. Cards and rows pass nothing and keep the
 * shipped chip. */
export function CrsChip({ table, onOpen }: { table: DataTable; onOpen?: () => void }) {
  if (!table.crsAssumed) return null;
  if (!onOpen) {
    return (
      <span
        className={gallery.chipWarn}
        title="The file declared no CRS; WGS84 was assumed"
      >
        WGS84 assumed
      </span>
    );
  }
  return (
    <span className={gallery.chipDoorWrap}>
      <button
        type="button"
        className={`${gallery.chipWarn} ${gallery.chipDoor}`}
        onClick={onOpen}
        aria-describedby="crs-chip-tip"
        data-set-geometry-door="crs"
      >
        WGS84 assumed
        <CaretIcon />
      </button>
      <span className={gallery.tip} role="tooltip" id="crs-chip-tip">
        {CRS_DOOR_TIP}
        <small>{CRS_DOOR_TIP_ACTION}</small>
      </span>
    </span>
  );
}

/** The suspect-header warning — advisory, in the assumed-CRS
 * chip's manner. The copy was written at a field round. */
export const HEADER_SUSPECT_TITLE =
  "The CSV's column names look like data. The header row was probably " +
  "missing or never split";

export function HeaderChip({ table }: { table: DataTable }) {
  if (!table.headerSuspect) return null;
  return (
    <span className={gallery.chipWarn} title={HEADER_SUSPECT_TITLE}>
      Header looks broken
    </span>
  );
}
