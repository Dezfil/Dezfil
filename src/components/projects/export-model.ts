import { formatBytes } from "../api";
import {
  datasetFileName,
  type DatasetFormat,
} from "@/lib/export/dataset-format";
import { archiveBaseName, memberFileNames } from "@/lib/export/project-archive";

/**
 * The 16-C export dialog's pure model: the picker rows' facts and
 * sub-line precedence, the group smalls, the exact footer and download
 * forms, the partial-size qualification, the omitted line, and the
 * review tree with its display-only truncation. The dialog only
 * presents.
 */

export interface ExportMapRow {
  id: string;
  name: string;
  layerCount: number;
  published: boolean;
}

export interface ExportWorkflowRow {
  id: string;
  name: string;
  nodeCount: number;
}

export interface ExportDatasetRow {
  id: string;
  name: string;
  sizeBytes: number | null;
  source: string;
  projectIds: string[];
  /** The dataset's spatial identity, for the tile. */
  geometryColumn: string | null;
  geometryType: string | null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function mapRowMeta(row: ExportMapRow): string {
  return `${plural(row.layerCount, "layer")}${row.published ? " · published" : ""}`;
}

export function workflowRowMeta(row: ExportWorkflowRow): string {
  return plural(row.nodeCount, "node");
}

/** The dataset sub-line: the shared-copy line wins over the result
 * line when both apply (the reference's rule); other memberships in the
 * shipped stable order (alphabetical, the rule — for several this
 * deviates from the reference's first-name-only line, recorded). */
export function datasetSub(
  row: ExportDatasetRow,
  scopeProjectId: string,
  names: ReadonlyMap<string, string>,
): string {
  const others = row.projectIds
    .filter((id) => id !== scopeProjectId)
    .map((id) => names.get(id))
    .filter((n): n is string => typeof n === "string")
    .sort((a, b) => a.localeCompare(b));
  if (others.length > 0) {
    return `also in ${others.join(", ")}, included as a copy`;
  }
  if (row.source === "operation") {
    return "a result; its workflow makes it again";
  }
  return "";
}

/** The selected datasets' artifact-size total under the rule: sum
 * the known sizes; any unknown marks the total partial. */
export function sizeTotal(rows: ExportDatasetRow[]): {
  bytes: number;
  partial: boolean;
} {
  let bytes = 0;
  let partial = false;
  for (const r of rows) {
    if (r.sizeBytes === null) partial = true;
    else bytes += r.sizeBytes;
  }
  return { bytes, partial };
}

/** The shipped partial form: "≥ 2 KB" (the sizeLabel precedent). */
export function sizeText(total: { bytes: number; partial: boolean }): string {
  return `${total.partial ? "≥ " : ""}${formatBytes(total.bytes)}`;
}

/** The group heading's small: the count alone when everything is
 * selected, "n of m" otherwise; datasets append the size. */
export function groupSmall(picked: number, all: number, size?: string): string {
  const counts = picked === all ? String(picked) : `${picked} of ${all}`;
  return size === undefined ? counts : `${counts} · ${size}`;
}

export interface SelectionCounts {
  maps: number;
  workflows: number;
  datasets: number;
}

/** The footer's exact form, zero counts included — or "Nothing
 * chosen". A null size (a converting format) claims no total. */
export function footerStatus(
  counts: SelectionCounts,
  size: string | null,
): string {
  const total = counts.maps + counts.workflows + counts.datasets;
  if (total === 0) return "Nothing chosen";
  const counted = `${plural(counts.maps, "map")} · ${plural(counts.workflows, "workflow")} · ${plural(counts.datasets, "dataset")}`;
  return size === null ? counted : `${counted} · ${size}`;
}

/** "Left out:" content — each non-zero omitted group, dot-joined;
 * empty when nothing is omitted. */
export function omittedLine(left: SelectionCounts): string {
  const parts: string[] = [];
  if (left.maps) parts.push(plural(left.maps, "map"));
  if (left.workflows) parts.push(plural(left.workflows, "workflow"));
  if (left.datasets) parts.push(plural(left.datasets, "dataset"));
  return parts.join(" · ");
}

export interface TreeRow {
  depth: 0 | 1 | 2;
  label: string;
  note?: string;
  kind: "dir" | "file";
}

/** The review tree (complete):
 * the root by the effective name, the manifest's note, a folder per
 * non-empty chosen group, and EVERY chosen file named — the frame
 * scrolls, the list never summarizes. Dataset names carry the effective
 * extension under the chosen format. File names
 * ride the same shared rules the server applies. */
export function treeRows(opts: {
  file: string;
  maps: ExportMapRow[];
  workflows: ExportWorkflowRow[];
  datasets: ExportDatasetRow[];
  /** The datasets folder's note; null when no size can be claimed. */
  datasetSize: string | null;
  datasetFormat?: DatasetFormat;
}): TreeRow[] {
  const base = archiveBaseName(opts.file);
  const rows: TreeRow[] = [
    { depth: 0, label: `${base}.dezfil/`, kind: "dir" },
    {
      depth: 1,
      label: "project.json",
      note: "name, note, what is inside",
      kind: "file",
    },
  ];
  const folder = (label: string, note: string, files: string[]) => {
    rows.push({ depth: 1, label, note, kind: "dir" });
    for (const f of files) rows.push({ depth: 2, label: f, kind: "file" });
  };
  if (opts.maps.length) {
    folder(
      "maps/",
      plural(opts.maps.length, "map"),
      memberFileNames(opts.maps.map((m) => m.name)).map((f) => `${f}.json`),
    );
  }
  if (opts.workflows.length) {
    folder(
      "workflows/",
      plural(opts.workflows.length, "workflow"),
      memberFileNames(opts.workflows.map((w) => w.name)).map(
        (f) => `${f}.json`,
      ),
    );
  }
  if (opts.datasets.length) {
    const format = opts.datasetFormat ?? "geoparquet";
    folder(
      "datasets/",
      opts.datasetSize === null
        ? plural(opts.datasets.length, "dataset")
        : `${plural(opts.datasets.length, "dataset")} · ${opts.datasetSize}`,
      opts.datasets.map((d) =>
        datasetFileName(d.name, format, d.geometryColumn !== null),
      ),
    );
  }
  return rows;
}
