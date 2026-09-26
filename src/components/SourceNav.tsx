"use client";

import styles from "./SourceNav.module.css";

/** One rail entry's presentation: icon tile, bold title, one-line
 * description. */
export interface SourceEntrySpec {
  title: string;
  desc: string;
  /** Tile content — a drawn SVG or a project logo image. */
  logo: React.ReactNode;
  /** Tile background class from the SourceNav sheet. */
  logoClass?: string;
}

/**
 * The source-nav entry: one anatomy for both dialogs' left rails — the
 * Data Explorer's Add data and the builder's add-layer catalog — so the
 * two navs cannot drift again. Grouping, titles and footers stay each
 * host's own.
 */
export function SourceNavButton({
  spec,
  active,
  onSelect,
}: {
  spec: SourceEntrySpec;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={styles.source}
      data-active={active || undefined}
      aria-current={active}
      onClick={onSelect}
    >
      <span className={`${styles.logo} ${spec.logoClass ?? ""}`}>
        {spec.logo}
      </span>
      <span className={styles.sourceText}>
        <strong>{spec.title}</strong>
        <small>{spec.desc}</small>
      </span>
    </button>
  );
}

/** The four import sources, identical in both rails.
 * Logo marks keep their NOTICE attributions from the Add-data dialog. */
export const IMPORT_SOURCES: Record<
  "files" | "overture" | "osm" | "postgis",
  SourceEntrySpec
> = {
  files: {
    title: "Files",
    desc: "Upload or read from a URL",
    logoClass: styles.logoFiles,
    logo: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
        <path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3" />
      </svg>
    ),
  },
  overture: {
    title: "Overture Maps",
    desc: "Places, buildings, boundaries",
    logoClass: styles.logoOverture,
    logo: (
      // eslint-disable-next-line @next/next/no-img-element -- static SVG mark, Overture Maps Foundation (see NOTICE)
      <img src="/logos/overture.svg" alt="" />
    ),
  },
  osm: {
    title: "OpenStreetMap",
    desc: "Area + tags → table",
    logoClass: styles.logoOsm,
    logo: (
      // eslint-disable-next-line @next/next/no-img-element -- static SVG, OpenStreetMap logo CC-BY-SA (see NOTICE)
      <img src="/logos/osm.svg" alt="" />
    ),
  },
  postgis: {
    title: "PostGIS",
    desc: "Snapshot from your database",
    logoClass: styles.logoPostgis,
    logo: (
      // eslint-disable-next-line @next/next/no-img-element -- static SVG, PostgreSQL elephant mark (see NOTICE)
      <img src="/logos/postgresql.svg" alt="" />
    ),
  },
};

/** The catalog's two working sources, same anatomy, drawn icons. */
export const CATALOG_SOURCES: Record<"tables" | "sql", SourceEntrySpec> = {
  tables: {
    title: "Tables",
    desc: "Layers from tables you already have",
    logoClass: styles.logoTables,
    logo: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
        <path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
      </svg>
    ),
  },
  sql: {
    title: "SQL query",
    desc: "Write the query that becomes the layer",
    logoClass: styles.logoSql,
    logo: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="m8 9-4 3 4 3M16 9l4 3-4 3" />
      </svg>
    ),
  },
};
