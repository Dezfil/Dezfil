import { execFile, type ExecFileException } from "node:child_process";
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

/** How long a program asked to stop has to end on its own before it is
 * ended outright. */
const STOP_GRACE_MS = 2_000;

/** How one bounded run of a program ended, and whether it was stopped. */
interface ProgramRun {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
  stopped: boolean;
}

/**
 * Run `bin` once, bounded: past `limitMs`, or once `signal` aborts, it is
 * asked to stop, and ended outright if it has not exited within a short
 * grace. The run settles only once the process is gone, so whatever follows
 * (removing its folder, the next run) never proceeds beside it.
 */
function runProgram(bin: string, args: string[], limitMs: number, signal?: AbortSignal): Promise<ProgramRun> {
  return new Promise((resolve) => {
    let stopped = false;
    let ending = false;
    let exited = false;
    let ended: Omit<ProgramRun, "stopped"> | null = null;
    let force: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      ended = { error, stdout: String(stdout), stderr: String(stderr) };
      settle();
    });
    /** Ask the program to stop, and end it outright past the grace. */
    function end(): void {
      if (ending || exited) return;
      ending = true;
      // Its pipes are let go, so a helper still holding them cannot keep the
      // run open once the program itself is gone.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGTERM");
      force = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, STOP_GRACE_MS);
    }
    function stop(): void {
      if (exited) return;
      stopped = true;
      end();
    }
    function settle(): void {
      if (!ended) return;
      // Started and not yet gone: end it first, and settle on its exit.
      if (!exited && child.pid !== undefined) return end();
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", stop);
      resolve({ ...ended, stopped });
    }
    child.once("exit", () => { exited = true; settle(); });
    const timer = setTimeout(stop, limitMs);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

async function probeVersion(bin: string): Promise<string | null> {
  const run = await runProgram(bin, ["--version"], 10_000);
  if (run.error || run.stopped) return null;
  // The version banner goes to stderr.
  const banner = `${run.stderr}${run.stdout}`.trim().split("\n")[0] ?? "";
  return banner || null;
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
 * stopped, ended outright if it does not stop, and the run returns only
 * once it is gone. The layer build lane and the tile builder's Test both
 * run the tiler through here; neither waits for the other.
 */
export async function runTiler(input: string, output: string, timeoutMs: number, signal?: AbortSignal): Promise<TilerRun> {
  const run = await runProgram(
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
    timeoutMs,
    signal,
  );
  if (!run.error && !run.stopped) return { ok: true };
  const detail = run.stderr.trim().split("\n").slice(-3).join(" ");
  const code = run.error?.code;
  if (code === "ENOENT" || code === "EACCES") return { ok: false, reason: "not_found", detail };
  return { ok: false, reason: run.stopped ? "timed_out" : "failed", detail };
}
