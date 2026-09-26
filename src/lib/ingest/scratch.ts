import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";

/** The ingest scratch directory: uploads, downloads and exports in flight. */
export function ingestScratchDir(): string {
  return path.join(dataDir(), "tmp");
}

/**
 * Boot sweep: a SIGKILL or OOM mid-transfer leaves partial files behind,
 * and every writer's own cleanup only covers its own lifetime. At process
 * start no writer is alive in a one-container deployment, so removing
 * everything here is safe. The durable Overpass cache lives under cache/,
 * not here, and is never swept — it shrinks only by its own TTL and budget
 * maintenance.
 */
export async function cleanIngestScratch(): Promise<void> {
  await rm(ingestScratchDir(), { recursive: true, force: true });
  await mkdir(ingestScratchDir(), { recursive: true });
}
