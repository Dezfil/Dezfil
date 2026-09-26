import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

/**
 * Private, process-local hand-off for project-export downloads (the
 * prepare-then-redeem road): the POST assembles and finalizes the
 * archive on disk, this store keeps it alive for one native browser
 * navigation to redeem, and the staged file is deleted on redeem
 * completion, redeem failure, or expiry — never abandoned.
 */

export const PROJECT_EXPORT_TICKET_TTL_MS = 60_000;

interface Entry {
  key: string;
  path: string;
  filename: string;
  size: number;
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();

const discard = (path: string) => {
  void rm(path, { force: true }).catch(() => {});
};

export function createProjectExportTicket(file: {
  path: string;
  filename: string;
  size: number;
}): { ticket: string; key: string } {
  const ticket = randomBytes(16).toString("hex");
  const key = randomBytes(16).toString("hex");
  const timer = setTimeout(() => {
    entries.delete(ticket);
    discard(file.path);
  }, PROJECT_EXPORT_TICKET_TTL_MS);
  timer.unref?.();
  entries.set(ticket, { key, ...file, timer });
  return { ticket, key };
}

/** Single use: a successful claim removes the entry; the claimer MUST
 * call settle() when its stream ends, however it ends — that is what
 * deletes the staged file. */
export function claimProjectExportTicket(
  ticket: string,
  key: string,
): {
  path: string;
  filename: string;
  size: number;
  settle: () => void;
} | null {
  const entry = entries.get(ticket);
  if (!entry || entry.key !== key) return null;
  clearTimeout(entry.timer);
  entries.delete(ticket);
  return {
    path: entry.path,
    filename: entry.filename,
    size: entry.size,
    settle: () => discard(entry.path),
  };
}
