import type { DataTable } from "@/lib/metadata/tables";
import type { TableInspection, TableListing } from "@/lib/table-service";
import type { RecipeOrigin } from "@/lib/metadata/recipes";
import type { WorkflowListing } from "./workflow-model";
import type { MapOverview } from "@/lib/map-service";
import type { OperationDef } from "@/lib/operations/catalog";
import { serverUnreachable } from "./failure-copy";
import { classOfTable } from "./geometry-class";

export type { DataTable, TableInspection, TableListing, MapOverview };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** A sql_error's place in the submitted SQL, 1-based. */
    position?: { line: number; column: number };
  };
}

/** Extract the documented error shape from a failed API response. */
export async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return body.error.message;
  } catch {
    return `Request failed (${response.status})`;
  }
}

/** Like readApiError, but keeps the machine-readable code —
 * truth surfaces key their prose on it. An unparseable body falls back to
 * the documented `internal` code, never to raw text. */
export async function readApiFailure(
  response: Response,
): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error?.code && body?.error?.message) return body.error;
  } catch {
    // fall through to the generic shape
  }
  return { code: "internal", message: `Request failed (${response.status})` };
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function geometryLabel(t: DataTable): string {
  const geometryClass = classOfTable(t);
  if (geometryClass === "none") return "non-spatial";
  if (t.geometryType === null) return "geometry unknown";
  return String(t.geometryType).toLowerCase().replace(/_/g, " ");
}

/** "2 h ago"-style relative time for cards and lists. */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} w ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Human size for a byte count; em dash when unknown. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/** Compact count for card overlays: 48.2k, 1.2M. */
export function formatCompactCount(n: number): string {
  if (n < 10_000) return new Intl.NumberFormat("en-US").format(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/**
 * The browser-safe reads the workflow canvas shares with the console's
 * table listing and the builder's operation catalog: one request each,
 * throwing the documented error text, so a page can compose them into one
 * exclusive state.
 */
export async function readTables(): Promise<TableListing[]> {
  let response: Response;
  try {
    response = await fetch("/api/tables", { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("read your tables"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TableListing[];
}

/** The recipes listing, by origin when asked: the
 * Workflows list reads the workflows, the Data page reads them to fold
 * their outputs into folders. */
export async function readRecipes(origin?: RecipeOrigin): Promise<WorkflowListing[]> {
  let response: Response;
  try {
    response = await fetch(origin ? `/api/recipes?origin=${origin}` : "/api/recipes", { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the workflows"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { recipes: WorkflowListing[] }).recipes;
}

export async function readOperations(): Promise<OperationDef[]> {
  let response: Response;
  try {
    response = await fetch("/api/operations");
  } catch {
    throw new Error(serverUnreachable("read the operations"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { operations: OperationDef[] }).operations;
}
