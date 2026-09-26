import path from "node:path";

/**
 * The single durable directory. Everything Dezfil persists — data artifacts, metadata, published
 * links — lives under here; backup/restore is "copy it". Defaults to./data for local dev; the
 * container image sets /data.
 */
export function dataDir(): string {
  return process.env.DEZFIL_DATA_DIR ?? path.join(process.cwd(), "data");
}
