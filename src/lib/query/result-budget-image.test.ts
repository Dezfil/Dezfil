import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it, vi, type TestContext } from "vitest";

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Whether any process of the group the shell leads is still there. */
function groupAlive(leader: number): boolean {
  try { process.kill(-leader, 0); return true; } catch { return false; }
}

/** For the never-ending run: a docker double that notes its own id at
 * `note` and then never answers, and a hook told the shell's id and the
 * scratch folder once the run starts. */
interface NeverAnswering { note: string; started: (run: { shell: number; directory: string }) => void }

/** One run of the driver over the command doubles. The run keeps no clock
 * of its own: every command it makes starts a fresh double, so its length
 * is the machine's speed times the script's own patience, and only the
 * case's timeout stands guard against a hang. The script runs in a process
 * group of its own, which is ended and waited out, and the scratch folder
 * removed, whichever way the case ends: its run over, its case finished,
 * or the case timed out or cancelled. */
async function driver(context: Pick<TestContext, "signal" | "onTestFinished">, readiness: number[], failMode = "", args = ["--full"], neverAnswering?: NeverAnswering) {
  const directory = mkdtempSync(join(tmpdir(), "budget-driver-"));
  let run: ChildProcess | undefined;
  let closed: Promise<number | null> = Promise.resolve(null);
  let ending: Promise<void> | undefined;
  const end = () => ending ??= (async () => {
    const shell = run?.pid;
    if (shell !== undefined) {
      try { process.kill(-shell, "SIGKILL"); } catch { /* the group is gone already */ }
      await closed.catch(() => null);
      for (let i = 0; i < 500 && groupAlive(shell); i += 1) await sleep(10);
    }
    rmSync(directory, { recursive: true, force: true });
  })();
  context.onTestFinished(() => end());
  try {
    const double = readFileSync("test-support/result-budget-driver-command.mjs", "utf8");
    for (const command of ["docker", "sleep"]) {
      writeFileSync(join(directory, command), `#!${process.execPath}\n${double}`, { mode: 0o755 });
    }
    if (neverAnswering) {
      writeFileSync(join(directory, "docker"), `#!/bin/sh\necho $$ > '${neverAnswering.note}.tmp' && mv '${neverAnswering.note}.tmp' '${neverAnswering.note}'\nexec /bin/sleep 3600\n`, { mode: 0o755 });
    }
    run = spawn("sh", ["scripts/result-budget-image.sh", "budget-fixture:local", ...args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUDGET_DRIVER_STATE: directory,
        BUDGET_DRIVER_READINESS: JSON.stringify(readiness), BUDGET_DRIVER_FAIL_MODE: failMode },
    });
    const started = run;
    closed = new Promise<number | null>((settle, fail) => { started.once("error", fail); started.once("close", settle); });
    if (started.pid !== undefined) neverAnswering?.started({ shell: started.pid, directory });
    const cancelled = new Promise<never>((_, fail) => {
      const stop = () => { fail(context.signal.reason); void end(); };
      if (context.signal.aborted) stop(); else context.signal.addEventListener("abort", stop, { once: true });
    });
    const status = await Promise.race([closed, cancelled]);
    const log = join(directory, "commands.jsonl");
    const commands: string[][] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { status, commands };
  } finally { await end(); }
}

function expectOwnedCleanup(commands: string[][], count = 3) {
  const started = commands.filter(c => c[1] === "run").map(c => c[c.indexOf("--name") + 1]);
  expect(started).toHaveLength(count);
  expect(new Set(started).size).toBe(count);
  for (const name of started) expect(name).toMatch(/^dezfil-budget-(small|normal|source)-\d+$/);
  const suffix = started[0].split("-").at(-1);
  expect(commands.find(c => c[1] === "rm")).toEqual(["docker", "rm", "-f", "-v",
    `dezfil-budget-source-${suffix}`, `dezfil-budget-small-${suffix}`, `dezfil-budget-normal-${suffix}`]);
  for (const command of commands.filter(c => c[1] === "run" && !c.includes("postgis/postgis:16-3.4"))) {
    expect(command).toContain(`${resolve("scripts")}:/probes:ro`);
    expect(command).toContain("budget-fixture:local");
  }
}

it("waits for three consecutive TCP successes after initialization and a restart", async (context) => {
  const { status, commands } = await driver(context, [1, 0, 1, 0, 0, 0]);
  expect(status).toBe(0);
  const full = commands.findIndex(c => c.includes("--full"));
  expect(full).toBeGreaterThan(0);
  expect(commands.slice(0, full).filter(c => c.includes("pg_isready"))).toHaveLength(6);
  expectOwnedCleanup(commands);
});

it("fails closed and cleans owned containers when TCP never becomes ready", async (context) => {
  // What bounds this case is the script's patience: it gives up after sixty
  // readiness attempts over TCP, each followed by a pause, about a hundred
  // and thirty doubles in all. The count is the proof that it stopped
  // because readiness never came; the timeout is only a hang guard, far
  // past that work on a loaded machine.
  const { status, commands } = await driver(context, [1]);
  expect(status).not.toBe(0);
  expect(commands.filter(c => c.includes("pg_isready"))).toHaveLength(60);
  expect(commands.some(c => c.includes("--full"))).toBe(false);
  expectOwnedCleanup(commands);
}, 120_000);

it("cleans owned containers and volumes when the full probe fails", async (context) => {
  const { status, commands } = await driver(context, [0], "--full");
  expect(status).toBe(9);
  expectOwnedCleanup(commands);
});

it.for([{ args: [] as string[] }, { args: ["--quick"] }])("runs only source-free arms in pipeline mode $args", async ({ args }, context) => {
  const { status, commands } = await driver(context, [0], "", args);
  expect(status).toBe(0);
  expect(commands.filter(c => c.includes("/probes/query-result-budget-probe.mjs")).map(c => c.at(-1))).toEqual(["--refused", "--quick"]);
  expect(commands.some(c => c.includes("postgis/postgis:16-3.4") || c.includes("pg_isready"))).toBe(false);
  expectOwnedCleanup(commands, 2);
});

it("keeps the complete outside matrix and admission observation behind the full flag", async (context) => {
  const { status, commands } = await driver(context, [0]);
  expect(status).toBe(0);
  expect(commands.filter(c => c.includes("/probes/query-result-budget-probe.mjs")).map(c => c.at(-1))).toEqual(["--refused", "--full", "--admitted"]);
  const source = commands.find(c => c.includes("postgis/postgis:16-3.4"))!;
  const normal = commands.find(c => c[1] === "run" && c.includes("PORT=3402"))!;
  expect(source).toContain(`--network=container:${normal[normal.indexOf("--name") + 1]}`);
  expect(commands.find(c => c.includes("--full"))).toContain("DEZFIL_TEST_PG_URL=postgresql://budget:budget-fixture-only@127.0.0.1:5432/budget");
  expectOwnedCleanup(commands);
});

it.for(["--refused", "--quick"])("cleans owned names when pipeline arm %s fails", async (mode, context) => {
  const { status, commands } = await driver(context, [0], mode, ["--quick"]);
  expect(status).toBe(9);
  expectOwnedCleanup(commands, mode === "--refused" ? 1 : 2);
});

it("rejects an unknown mode before starting containers", async (context) => {
  const { status, commands } = await driver(context, [0], "", ["--ful"]);
  expect(status).not.toBe(0);
  expect(commands).toEqual([]);
});

describe("a run that never ends", () => {
  const notes = mkdtempSync(join(tmpdir(), "budget-never-"));
  const note = join(notes, "double.pid");
  let run: { shell: number; directory: string } | undefined;
  let endedByItself = false;
  afterAll(() => rmSync(notes, { recursive: true, force: true }));

  // The control: a docker double that never answers, the case held to a
  // short timeout, so the runner gives up on it with the script still
  // running. The next case reads what this one left behind.
  it.fails("is given up by its case at the case's timeout", async (context) => {
    await driver(context, [1], "", ["--full"], { note, started: (started) => { run = started; } });
    endedByItself = true;
  }, 3_000);

  it("leaves no process of the script's group and no scratch folder behind", async () => {
    expect(run, "the never-ending run started").toBeDefined();
    expect(endedByItself, "the never-ending run ended before its case's timeout").toBe(false);
    expect(existsSync(note), "the docker double was reached and noted itself").toBe(true);
    const double = Number(readFileSync(note, "utf8"));
    expect(double).toBeGreaterThan(1);
    await vi.waitFor(() => {
      expect(alive(double), "the never-answering double").toBe(false);
      expect(alive(run!.shell), "the script's shell").toBe(false);
      expect(groupAlive(run!.shell), "a process of the script's group").toBe(false);
      expect(existsSync(run!.directory), "the run's scratch folder").toBe(false);
    }, { timeout: 5_000 });
  });
});
