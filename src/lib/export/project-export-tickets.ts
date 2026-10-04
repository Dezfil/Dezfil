import { removeAccountFile } from "@/lib/ingest/file-ownership";
import type { AccountScope } from "@/lib/auth/scope";
import { randomBytes } from "node:crypto";
import { LayerDownloadTicketStore, type TicketStoreState } from "./layer-download-tickets";

export const PROJECT_EXPORT_TICKET_TTL_MS = 60_000;
const projectExportTicketsKey = Symbol.for("dezfil.projectExportTickets");
const projectExportTicketsHost = globalThis as typeof globalThis & { [projectExportTicketsKey]?: TicketStoreState };
const projectTicketState: TicketStoreState = projectExportTicketsHost[projectExportTicketsKey] ??= { entries: new Map(), pending: new Set() };
export const projectExportTickets = new LayerDownloadTicketStore({ preparedTtlMs: PROJECT_EXPORT_TICKET_TTL_MS }, projectTicketState);
const binding = (projectId: string, key: string) => ({ layerId: `${projectId}:${key}`, format: "geoparquet" as const });

/** A private copy keeps its preparation lifetime and its claimed stream's
 * actual settlement. Cleanup remains tracked even after the single-use claim. */
export function createProjectExportTicket(scope: AccountScope, projectId: string, file: {
  path: string; filename: string; size: number;
}): { ticket: string; key: string } {
  const key = randomBytes(16).toString("hex");
  const ticket = projectExportTickets.prepare(scope, binding(projectId, key), {
    ...file, contentType: "application/zip", cleanup: () => removeAccountFile(file.path, { force: true }),
  });
  return { ticket, key };
}
export function claimProjectExportTicket(scope: AccountScope, projectId: string, ticket: string, key: string): {
  path: string; filename: string; size: number; settle: () => void;
} | null {
  const claimed = projectExportTickets.claim(scope, ticket, binding(projectId, key));
  return claimed && { path: claimed.path, filename: claimed.filename, size: claimed.size, settle: claimed.fail };
}
