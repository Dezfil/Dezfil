import { execFile } from "node:child_process";
import { executableFound } from "@/lib/system/executable";

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

/** One probe of one binary path: its answer, and that answer once known. */
interface Probe {
  bin: string;
  version: Promise<string | null>;
  known: string | null;
}
let probe: Probe | null = null;

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

/** Start a probe of `bin`, keeping what an earlier probe of it knew until
 * this one answers. */
function startProbe(bin: string): Probe {
  const entry: Probe = { bin, known: probe?.bin === bin ? probe.known : null, version: probeVersion(bin) };
  void entry.version.then((version) => { entry.known = version; });
  return entry;
}

/** The tiler's version banner, or null when it cannot run. Probed once per
 * binary path; tests re-point DEZFIL_TIPPECANOE and get a fresh probe. */
export function tilerVersion(): Promise<string | null> {
  const bin = tippecanoePath();
  if (!probe || probe.bin !== bin) probe = startProbe(bin);
  return probe.version;
}

/** Probe the configured binary afresh, as it is now, and keep what it
 * answers for every later read. */
export function probeTilerVersion(): Promise<string | null> {
  probe = startProbe(tippecanoePath());
  return probe.version;
}

/** The version banner the last probe of the configured binary answered, or
 * null when none has answered or it could not run. Reads; runs nothing. */
export function knownTilerVersion(): string | null {
  return probe?.bin === tippecanoePath() ? probe.known : null;
}

/** Whether the configured binary is an executable file where its setting
 * points: a file check, never a run. */
export function tilerFound(): boolean {
  return executableFound(tippecanoePath());
}

export async function tilerAvailable(): Promise<boolean> {
  return (await tilerVersion()) !== null;
}

/** How one run of the tiler ended. `detail` is the last lines the tiler
 * wrote about its failure, for the layer's own build message alone. */
export type TilerRun =
  | { ok: true }
  | { ok: false; reason: "not_found" | "timed_out" | "failed"; detail: string };

/**
 * One bounded run of the tiler: newline-delimited GeoJSON in, one PMTiles
 * archive out. Past `timeoutMs`, or once `signal` aborts, the process is
 * stopped. The layer build lane and the tile builder's Test both run the
 * tiler through here; neither waits for the other.
 */
export function runTiler(input: string, output: string, timeoutMs: number, signal?: AbortSignal): Promise<TilerRun> {
  return new Promise((resolve) => {
    execFile(
      tippecanoePath(),
      [
        "-o",
        output,
        "-l",
        "features",
        "-zg",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--force",
        "--quiet",
        "-P",
        input,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: true });
        const detail = String(stderr).trim().split("\n").slice(-3).join(" ");
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES") return resolve({ ok: false, reason: "not_found", detail });
        const stopped = error.killed || /SIGTERM/.test(String(error.signal)) || error.name === "AbortError";
        resolve({ ok: false, reason: stopped ? "timed_out" : "failed", detail });
      },
    );
  });
}
