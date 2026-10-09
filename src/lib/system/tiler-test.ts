import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tileScratchDir } from "@/lib/tiles/paths";
import { probeTilerVersion, runTiler, tilerFound } from "@/lib/tiles/tiler";

/**
 * The tile builder's Test: the tiler as configured now builds a small
 * archive from a few fixed points, in a folder of its own under the tile
 * scratch, which is removed whatever happens; a crash's folder goes with
 * the scratch at the next restart. The version is probed first, so it is
 * known from then on. The run is the build lane's own bounded step, taken
 * outside the lane: it neither waits behind a layer build nor holds one up.
 */

/** Four points in a small square, one feature per line, as the build lane
 * hands the tiler a layer. */
const POINTS = [[13.4, 52.52], [13.41, 52.52], [13.4, 52.53], [13.41, 52.53]]
  .map(([lng, lat], i) => JSON.stringify({ type: "Feature", properties: { n: i }, geometry: { type: "Point", coordinates: [lng, lat] } }))
  .join("\n") + "\n";

export async function buildTestArchive(limitMs: number, signal: AbortSignal): Promise<"built" | "not_found" | "timed_out" | "failed"> {
  if (!tilerFound()) return "not_found";
  await probeTilerVersion();
  if (signal.aborted) return "timed_out";
  await mkdir(tileScratchDir(), { recursive: true });
  const folder = await mkdtemp(path.join(tileScratchDir(), "part-test-"));
  try {
    const input = path.join(folder, "points.geojsonl");
    const output = path.join(folder, "points.pmtiles");
    await writeFile(input, POINTS);
    const run = await runTiler(input, output, limitMs, signal);
    if (!run.ok) return run.reason;
    const archive = await stat(output).catch(() => null);
    return archive?.isFile() && archive.size > 0 ? "built" : "failed";
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
