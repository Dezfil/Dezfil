import type { MapOverview, TableListing } from "../api";
import { formatBytes } from "../api";
import type { WorkflowListing } from "../workflow-model";

/**
 * The project home's pure derivations: the stats line agrees with the
 * sections by construction — every number counts exactly what its
 * section lists — and a shared dataset names every other membership,
 * order carrying no meaning (its principle).
 */

export interface HomeStats {
  maps: number;
  workflows: number;
  datasets: number;
  published: number;
  sizeLabel: string;
}

export function homeStats(members: {
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
}): HomeStats {
  let size = 0;
  let complete = true;
  for (const t of members.tables) {
    if (t.sizeBytes === null) complete = false;
    else size += t.sizeBytes;
  }
  const label = formatBytes(size);
  return {
    maps: members.maps.length,
    workflows: members.workflows.length,
    datasets: members.tables.length,
    published: members.maps.filter((m) => m.publishToken).length,
    sizeLabel: complete ? label : `≥ ${label}`,
  };
}

/** The other projects a dataset is in, named where a name is known —
 * an unknown name is omitted, never invented (the honest-partial rule);
 * alphabetical so order asserts nothing. */
export function otherMembershipNames(
  table: Pick<TableListing, "projectIds">,
  home: string,
  names: Map<string, string>,
): string[] {
  return table.projectIds
    .filter((id) => id !== home)
    .map((id) => names.get(id))
    .filter((name): name is string => typeof name === "string")
    .sort((a, b) => a.localeCompare(b));
}

/** The attention area's rows: inclusion and
 * count from the server's to-run-again classification; the cause
 * sentence only from what the steps truthfully report — a workflow
 * whose steps name nothing gets no invented reason. */
export interface AttentionRow {
  id: string;
  name: string;
  count: number;
  cause: string | null;
}

export function attentionRows(
  workflows: WorkflowListing[],
): AttentionRow[] {
  return workflows
    .filter((w) => w.summary.status === "run_again")
    .map((w) => {
      let cause: string | null = null;
      for (const step of w.steps) {
        const stale = step.causes[0];
        if (stale) {
          cause = `${stale.tableName} changed`;
          break;
        }
        if (step.conditions.includes("output_missing")) {
          cause = "an output dataset was deleted";
          break;
        }
        if (step.proposedParameters) {
          cause = "an edit awaits a run";
          break;
        }
      }
      return { id: w.id, name: w.name, count: w.summary.count, cause };
    });
}

/** The workflow card's time fact: the newest recorded run whatever its
 * outcome, the honest absence, or the bare glyph when the history could
 * not be read — never an invented "Never run". */
export function lastRunLabel(
  newestRun: string | null | "unreadable",
  formatRelative: (iso: string) => string,
): string {
  if (newestRun === "unreadable") return "—";
  return newestRun ? `ran ${formatRelative(newestRun)}` : "Never run";
}

/* The facts line, the list's run cell ---- */

/** One item of the head's facts line: a count with
 * its kind glyph, a bare fact, or the created time alone. */
export interface Fact {
  key: "maps" | "workflows" | "datasets" | "published" | "size" | "updated" | "created";
  kind?: "map" | "workflow" | "dataset";
  /** The bold number, when the fact is a count. */
  value?: string;
  label: string;
}

/** Only what exists: a kind when above zero, published when above zero,
 * the size (partial qualification kept) only with a dataset, the
 * project's own updated time always last; an empty project says only
 * when it was created. */
export function factsLine(
  stats: HomeStats,
  record: { createdAt: string; updatedAt: string },
  formatRelative: (iso: string) => string,
): Fact[] {
  if (stats.maps === 0 && stats.workflows === 0 && stats.datasets === 0) {
    return [{ key: "created", label: `created ${formatRelative(record.createdAt)}` }];
  }
  const out: Fact[] = [];
  if (stats.maps > 0) {
    out.push({ key: "maps", kind: "map", value: String(stats.maps), label: stats.maps === 1 ? "map" : "maps" });
  }
  if (stats.workflows > 0) {
    out.push({ key: "workflows", kind: "workflow", value: String(stats.workflows), label: stats.workflows === 1 ? "workflow" : "workflows" });
  }
  if (stats.datasets > 0) {
    out.push({ key: "datasets", kind: "dataset", value: String(stats.datasets), label: stats.datasets === 1 ? "dataset" : "datasets" });
  }
  if (stats.published > 0) {
    out.push({ key: "published", value: String(stats.published), label: "published" });
  }
  if (stats.datasets > 0) out.push({ key: "size", label: stats.sizeLabel });
  out.push({ key: "updated", label: `updated ${formatRelative(record.updatedAt)}` });
  return out;
}

/** The list row's Last run cell: the bare time,
 * "never", or the shipped glyph with its explanation when the history
 * could not be read — the glyph reused, never a second literal. */
export function lastRunCell(
  newestRun: string | null | "unreadable",
  formatRelative: (iso: string) => string,
): { text: string; title?: string } {
  if (newestRun === "unreadable") {
    return {
      text: lastRunLabel(newestRun, formatRelative),
      title: "The run history couldn't be read",
    };
  }
  return { text: newestRun ? formatRelative(newestRun) : "never" };
}
