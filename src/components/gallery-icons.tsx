import type { Ref } from "react";
import { classOfTable } from "./geometry-class";

/** Shared stroke icons and drawn artwork for the Maps/Data gallery screens
 * Strokes follow the Wheelhouse icon language (1.7px, round). */

function Stroke({
  children,
  width = 1.7,
}: {
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconSearch = () => (
  <Stroke>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Stroke>
);

export const IconGrid = () => (
  <Stroke>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Stroke>
);

export const IconList = () => (
  <Stroke>
    <path d="M4 6h.5M9 6h11M4 12h.5M9 12h11M4 18h.5M9 18h11" />
  </Stroke>
);

export const IconOpen = () => (
  <Stroke>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Stroke>
);

export const IconDuplicate = () => (
  <Stroke>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Stroke>
);

export const IconLink = () => (
  <Stroke>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Stroke>
);

export const IconPublish = () => (
  <Stroke>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Stroke>
);

export const IconTrash = () => (
  <Stroke>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6" />
  </Stroke>
);

/** The people glyph at the gallery's weight, so a card's Share action
 * sits level with its neighbours; the chrome-tier glyph in the shared
 * icon module draws the same figure heavier. */
export const IconPeople = () => (
  <Stroke>
    <circle cx="9.2" cy="8.4" r="3.2" />
    <path d="M3.2 19.6c.7-3.1 3.1-5 6-5s5.3 1.9 6 5M15.4 5.6a3.2 3.2 0 0 1 0 5.6M17.6 14.9c1.7.6 3 2.2 3.5 4.7" />
  </Stroke>
);

export const IconSql = () => (
  <Stroke>
    <path d="m8 9-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />
  </Stroke>
);

export const IconAddToMap = () => (
  <Stroke>
    <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" />
    <path d="M12 9v6M9 12h6" />
  </Stroke>
);

export const IconRefresh = () => (
  <Stroke>
    <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
  </Stroke>
);

export const IconDownload = () => (
  <Stroke>
    <path d="M12 3v12M7 10l5 5 5-5M4 19h16" />
  </Stroke>
);

export const IconTable = () => (
  <Stroke>
    <path d="M3 5h18v14H3zM3 10h18M9 5v14" />
  </Stroke>
);

export const IconMap = () => (
  <Stroke>
    <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15" />
  </Stroke>
);

export const IconWorkflow = () => (
  <Stroke>
    <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="14" y="14" width="6.5" height="6.5" rx="1.5" />
    <path d="M10 6.75h4.75a2 2 0 0 1 2 2V14M14 17.25H9.25a2 2 0 0 1-2-2V10" />
  </Stroke>
);

export const IconFolder = () => (
  <Stroke>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.9l2 2.4h8.1A1.5 1.5 0 0 1 21 8.9v9.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
  </Stroke>
);

/** The dataset kind's glyph: the rail's own cylinder, one
 * glyph wherever a kind is read beside maps and workflows. */
export const IconData = () => (
  <Stroke>
    <ellipse cx="12" cy="5" rx="7" ry="3" />
    <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
  </Stroke>
);

/** A template's glyph: the rail's own compass for Templates, one glyph
 * wherever a template is marked as one. */
export const IconTemplate = () => (
  <Stroke>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z" />
  </Stroke>
);

export const IconCaret = () => (
  <Stroke>
    <path d="m6 9 6 6 6-6" />
  </Stroke>
);

export const IconFolderPlus = () => (
  <Stroke>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.9l2 2.4h8.1A1.5 1.5 0 0 1 21 8.9v9.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12ZM12 11v6M9 14h6" />
  </Stroke>
);

export const IconRename = () => (
  <Stroke>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17l-1 4ZM14 6l3 3" />
  </Stroke>
);

export const IconBack = () => (
  <Stroke>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Stroke>
);

export type GeometryKind = "point" | "line" | "polygon" | "mixed" | "none";

/** Coarse geometry family for icons and motifs. A family composite
 * ("POINT+POLYGON") and any non-null type the families don't cover
 * (MIXED, GEOMETRYCOLLECTION, a bare GEOMETRY from an external catalog)
 * is still geometry — never "none". */
export function geometryKind(
  geometryType: string | null,
  geometryColumn?: string | null,
): GeometryKind {
  const geometryClass = classOfTable({ geometryType, geometryColumn });
  if (geometryClass === "none") return "none";
  if (geometryClass === "unknown") return "mixed";
  const t = String(geometryType).toUpperCase();
  if (t.includes("+") || t.includes("MIXED") || t.includes("COLLECTION"))
    return "mixed";
  if (t.includes("POINT")) return "point";
  if (t.includes("LINE")) return "line";
  if (t.includes("POLYGON")) return "polygon";
  return "mixed";
}

/** The families present, for drawing what a table actually holds: a
 * single family is itself; a composite ("POINT+POLYGON") is its parts; a
 * legacy MIXED or unrecognized spatial type is all three. */
export function geometryFamilies(
  geometryType: string | null,
  geometryColumn?: string | null,
): GeometryKind[] {
  const kind = geometryKind(geometryType, geometryColumn);
  if (kind === "none") return [];
  if (kind !== "mixed") return [kind];
  const parts = [
    ...new Set(
      (geometryType ?? "")
        .toUpperCase()
        .split("+")
        .map((p) =>
          p.includes("POINT")
            ? ("point" as const)
            : p.includes("LINE")
              ? ("line" as const)
              : p.includes("POLYGON")
                ? ("polygon" as const)
                : null,
        )
        .filter((p): p is "point" | "line" | "polygon" => p !== null),
    ),
  ];
  return parts.length > 1 ? parts : ["point", "line", "polygon"];
}

export function GeometryIcon({ kind }: { kind: GeometryKind }) {
  if (kind === "point") {
    return (
      <Stroke width={1.9}>
        <circle cx="7" cy="8" r="1.8" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="5.5" r="1.8" fill="currentColor" stroke="none" />
        <circle cx="18" cy="13" r="1.8" fill="currentColor" stroke="none" />
        <circle cx="9" cy="16.5" r="1.8" fill="currentColor" stroke="none" />
      </Stroke>
    );
  }
  if (kind === "line") {
    return (
      <Stroke width={1.9}>
        <path d="M3 19 C 8 19, 7 6, 12 6 S 16 14, 21 12" />
      </Stroke>
    );
  }
  if (kind === "polygon") {
    return (
      <Stroke width={1.9}>
        <path d="M5 9 12 4l7 4-1.5 9L9 20l-4.5-4Z" />
      </Stroke>
    );
  }
  if (kind === "mixed") {
    return (
      <Stroke width={1.9}>
        <path d="M4 10 9 5l5 3-1 7-6 2Z" />
        <circle cx="18.5" cy="8.5" r="1.8" fill="currentColor" stroke="none" />
        <circle cx="17" cy="16.5" r="1.8" fill="currentColor" stroke="none" />
      </Stroke>
    );
  }
  return (
    <Stroke width={1.9}>
      <path d="M3 5h18v14H3zM3 10h18M9 5v14" />
    </Stroke>
  );
}

/** Drawn geometry motif for a data card's preview strip — static art per
 * geometry family, in the accent ink (not a data render). A mixed table
 * draws exactly the families it holds, without labeling them. */
export function DataMotif({ kinds }: { kinds: GeometryKind[] }) {
  const kind = kinds.length === 1 ? kinds[0] : null;
  const mix = kinds.length > 1 ? new Set(kinds) : null;
  return (
    <svg
      viewBox="0 0 280 92"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      style={{ color: "var(--accent)" }}
    >
      {/* Art stays in the strip's upper band (y ≤ 60 of 92, per the M2
          study) so the count reading below it is never obscured. */}
      {kind === "point" && (
        <g fill="currentColor">
          <circle cx="34" cy="30" r="3.4" />
          <circle cx="62" cy="18" r="2.4" />
          <circle cx="88" cy="40" r="4" />
          <circle cx="120" cy="22" r="2.7" />
          <circle cx="148" cy="44" r="3.2" />
          <circle cx="178" cy="26" r="2.4" />
          <circle cx="205" cy="46" r="3.7" />
          <circle cx="234" cy="20" r="2.5" />
          <circle cx="256" cy="38" r="3" />
          <circle cx="52" cy="52" r="2.3" />
          <circle cx="110" cy="54" r="2.6" />
          <circle cx="168" cy="56" r="2.2" />
          <circle cx="228" cy="54" r="2.7" />
        </g>
      )}
      {kind === "line" && (
        <g
          stroke="currentColor"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
          opacity=".9"
        >
          <path d="M12 56 C 60 20, 100 52, 150 26 S 230 40, 268 18" />
          <path d="M2 40 C 50 60, 120 14, 180 42 S 250 24, 278 44" />
        </g>
      )}
      {kind === "polygon" && (
        <g fill="currentColor" stroke="currentColor" strokeWidth="1.2">
          <path d="M22 46 46 18l30 8-6 30-34 4Z" opacity=".25" />
          <path d="M96 50 112 16l38 6 4 28-42 8Z" opacity=".45" />
          <path d="M178 48 200 20l34 4 6 26-38 12Z" opacity=".3" />
          <path d="M244 52 258 24l26 6-2 24-30 6Z" opacity=".55" />
        </g>
      )}
      {mix && (
        <>
          {mix.has("polygon") && (
            <g fill="currentColor" stroke="currentColor" strokeWidth="1.2">
              <path d="M22 46 46 18l30 8-6 30-34 4Z" opacity=".28" />
              <path d="M178 48 200 20l34 4 6 26-38 12Z" opacity=".38" />
            </g>
          )}
          {mix.has("line") && (
            <path
              d="M12 56 C 60 20, 100 52, 150 26 S 230 40, 268 18"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              opacity=".65"
            />
          )}
          {mix.has("point") && (
            <g fill="currentColor">
              <circle cx="112" cy="22" r="3" />
              <circle cx="142" cy="44" r="2.6" />
              <circle cx="252" cy="42" r="3.2" />
              <circle cx="86" cy="52" r="2.3" />
            </g>
          )}
        </>
      )}
      {kinds.length === 0 && (
        <g
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          opacity=".55"
        >
          <path d="M30 16h90M30 32h220M30 48h160" />
          <path d="M150 8h100M210 24h40" opacity=".5" />
        </g>
      )}
    </svg>
  );
}

/** Neutral placeholder for a map card whose snapshot doesn't exist yet:
 * a quiet graticule with a compass rose — chart paper, no fake data. */
export function MapPlaceholder({ ref }: { ref?: Ref<SVGSVGElement> }) {
  return (
    <svg
      ref={ref}
      viewBox="0 0 320 190"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      style={{ color: "var(--fg-faint)" }}
    >
      <g stroke="currentColor" opacity=".18">
        <path d="M0 47h320M0 95h320M0 143h320M64 0v190M128 0v190M192 0v190M256 0v190" />
      </g>
      <g
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        opacity=".45"
        strokeLinecap="round"
      >
        <circle cx="160" cy="95" r="26" />
        <circle cx="160" cy="95" r="3" />
        <path d="M160 61v14M160 115v14M126 95h14M180 95h14" />
        <path d="m160 69 6 20-6 32-6-32z" opacity=".7" />
      </g>
    </svg>
  );
}
