"use client";

import { IconDownload } from "./gallery-icons";
import { Menu, MenuItem } from "./ui/Menu";
import styles from "./ExportMenu.module.css";

/** One export control for every surface: a download trigger
 * opening the three-format menu. The menu behaviour is the kit's — this
 * component was where that contract was written, and it is now a consumer
 * of it like every other menu. */
export function ExportMenu({
  name,
  spatial,
  triggerClassName,
}: {
  name: string;
  /** Whether the table has geometry — GeoJSON is only offered when it does. */
  spatial: boolean;
  triggerClassName?: string;
}) {
  const item = (format: string, label: string, hint: string) => (
    <MenuItem
      key={format}
      href={`/api/tables/${encodeURIComponent(name)}/export?format=${format}`}
    >
      {label} <small>{hint}</small>
    </MenuItem>
  );

  return (
    <Menu
      className={styles.wrap}
      label={`Export ${name}`}
      triggerClassName={triggerClassName}
      triggerProps={{ "data-hint": "Export this table" }}
      trigger={<IconDownload />}
      menuClassName={styles.menu}
    >
      {item("geoparquet", "GeoParquet", "as stored")}
      {spatial && item("geojson", "GeoJSON", "interchange")}
      {item("csv", "CSV", "geometry as WKT")}
    </Menu>
  );
}
