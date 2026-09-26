import { execFile } from "node:child_process";

/**
 * Tiler capability. Tippecanoe turns a layer's streamed result into a
 * PMTiles archive; the image bakes the binary in at build time, dev
 * machines install it themselves. Like h3, its absence degrades: only
 * over-cap layers are affected, with a layer-scoped error (plan: degrade,
 * don't break).
 */

/** The binary to run — a deployment can point at a custom build. */
export function tippecanoePath(): string {
  return process.env.DEZFIL_TIPPECANOE ?? "tippecanoe";
}

let probe: Promise<string | null> | null = null;
let probedPath: string | null = null;

function probeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      // The version banner goes to stderr.
      const banner = `${stderr}${stdout}`.trim().split("\n")[0] ?? "";
      resolve(banner || null);
    });
  });
}

/** The tiler's version banner, or null when it cannot run. Probed once per
 * binary path; tests re-point DEZFIL_TIPPECANOE and get a fresh probe. */
export function tilerVersion(): Promise<string | null> {
  const bin = tippecanoePath();
  if (!probe || probedPath !== bin) {
    probedPath = bin;
    probe = probeVersion(bin);
  }
  return probe;
}

export async function tilerAvailable(): Promise<boolean> {
  return (await tilerVersion()) !== null;
}
