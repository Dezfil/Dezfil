import type { DataTable } from "./api";
import { geometryLabel } from "./api";
import styles from "./GeometryBadge.module.css";

function Glyph({ type }: { type: string | null }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    "aria-hidden": true as const,
  };
  if (!type) {
    return (
      <svg {...common}>
        <path d="M2 6h8" opacity={0.7} />
      </svg>
    );
  }
  if (type.includes("POINT")) {
    return (
      <svg {...common}>
        <circle cx={6} cy={6} r={2.2} fill="currentColor" stroke="none" />
        <circle cx={6} cy={6} r={4.6} opacity={0.45} />
      </svg>
    );
  }
  if (type.includes("LINE")) {
    return (
      <svg {...common}>
        <path d="M1.5 9.5 5 4l3 4 2.5-6" />
      </svg>
    );
  }
  if (type.includes("POLYGON")) {
    return (
      <svg {...common}>
        <path d="M2 4.5 6 1.8l4 2.7-1.2 5H3.2Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx={3.5} cy={8} r={1.6} />
      <path d="M6.5 3.5h4M6.5 6.5 10 9.5" />
    </svg>
  );
}

export function GeometryBadge({ table }: { table: DataTable }) {
  return (
    <span className={styles.badge} data-spatial={table.geometryColumn !== null}>
      <Glyph type={table.geometryType} />
      {geometryLabel(table)}
    </span>
  );
}
