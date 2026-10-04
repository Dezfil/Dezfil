import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

function driver(readiness: number[], failMode = "", args = ["--full"]) {
  const directory = mkdtempSync(join(tmpdir(), "budget-driver-"));
  try {
    const double = readFileSync("test-support/result-budget-driver-command.mjs", "utf8");
    for (const command of ["docker", "sleep"]) {
      writeFileSync(join(directory, command), `#!${process.execPath}\n${double}`, { mode: 0o755 });
    }
    const result = spawnSync("sh", ["scripts/result-budget-image.sh", "budget-fixture:local", ...args], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUDGET_DRIVER_STATE: directory,
        BUDGET_DRIVER_READINESS: JSON.stringify(readiness), BUDGET_DRIVER_FAIL_MODE: failMode },
    });
    expect(result.error).toBeUndefined();
    const log = join(directory, "commands.jsonl");
    const commands: string[][] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { status: result.status, commands };
  } finally { rmSync(directory, { recursive: true, force: true }); }
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

it("waits for three consecutive TCP successes after initialization and a restart", () => {
  const { status, commands } = driver([1, 0, 1, 0, 0, 0]);
  expect(status).toBe(0);
  const full = commands.findIndex(c => c.includes("--full"));
  expect(full).toBeGreaterThan(0);
  expect(commands.slice(0, full).filter(c => c.includes("pg_isready"))).toHaveLength(6);
  expectOwnedCleanup(commands);
});

it("fails closed and cleans owned containers when TCP never becomes ready", () => {
  const { status, commands } = driver([1]);
  expect(status).not.toBe(0);
  expect(commands.some(c => c.includes("--full"))).toBe(false);
  expectOwnedCleanup(commands);
});

it("cleans owned containers and volumes when the full probe fails", () => {
  const { status, commands } = driver([0], "--full");
  expect(status).toBe(9);
  expectOwnedCleanup(commands);
});

it.each([{ args: [] }, { args: ["--quick"] }])("runs only source-free arms in pipeline mode $args", ({ args }) => {
  const { status, commands } = driver([0], "", args);
  expect(status).toBe(0);
  expect(commands.filter(c => c.includes("/probes/query-result-budget-probe.mjs")).map(c => c.at(-1))).toEqual(["--refused", "--quick"]);
  expect(commands.some(c => c.includes("postgis/postgis:16-3.4") || c.includes("pg_isready"))).toBe(false);
  expectOwnedCleanup(commands, 2);
});

it("keeps the complete outside matrix and admission observation behind the full flag", () => {
  const { status, commands } = driver([0]);
  expect(status).toBe(0);
  expect(commands.filter(c => c.includes("/probes/query-result-budget-probe.mjs")).map(c => c.at(-1))).toEqual(["--refused", "--full", "--admitted"]);
  const source = commands.find(c => c.includes("postgis/postgis:16-3.4"))!;
  const normal = commands.find(c => c[1] === "run" && c.includes("PORT=3402"))!;
  expect(source).toContain(`--network=container:${normal[normal.indexOf("--name") + 1]}`);
  expect(commands.find(c => c.includes("--full"))).toContain("DEZFIL_TEST_PG_URL=postgresql://budget:budget-fixture-only@127.0.0.1:5432/budget");
  expectOwnedCleanup(commands);
});

it.each(["--refused", "--quick"])("cleans owned names when pipeline arm %s fails", mode => {
  const { status, commands } = driver([0], mode, ["--quick"]);
  expect(status).toBe(9);
  expectOwnedCleanup(commands, mode === "--refused" ? 1 : 2);
});

it("rejects an unknown mode before starting containers", () => {
  const { status, commands } = driver([0], "", ["--ful"]);
  expect(status).not.toBe(0);
  expect(commands).toEqual([]);
});
