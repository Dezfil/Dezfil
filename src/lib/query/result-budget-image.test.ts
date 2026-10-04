import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

function driver(readiness: number[], failFull = false) {
  const directory = mkdtempSync(join(tmpdir(), "budget-driver-"));
  try {
    const double = readFileSync("test-support/result-budget-driver-command.mjs", "utf8");
    for (const command of ["docker", "sleep"]) {
      writeFileSync(join(directory, command), `#!${process.execPath}\n${double}`, { mode: 0o755 });
    }
    const result = spawnSync("sh", ["scripts/result-budget-image.sh", "budget-fixture:local", "--full"], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUDGET_DRIVER_STATE: directory,
        BUDGET_DRIVER_READINESS: JSON.stringify(readiness), BUDGET_DRIVER_FAIL_FULL: failFull ? "1" : "0" },
    });
    expect(result.error).toBeUndefined();
    const commands: string[][] = readFileSync(join(directory, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    return { status: result.status, commands };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function expectOwnedCleanup(commands: string[][]) {
  const started = commands.filter(c => c[1] === "run").map(c => c[c.indexOf("--name") + 1]);
  expect(started).toHaveLength(3);
  expect(new Set(started).size).toBe(3);
  for (const name of started) expect(name).toMatch(/^dezfil-budget-(small|normal|source)-\d+$/);
  expect(commands.find(c => c[1] === "rm")).toEqual(["docker", "rm", "-f", "-v", started[2], started[0], started[1]]);
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
  const { status, commands } = driver([0], true);
  expect(status).toBe(9);
  expectOwnedCleanup(commands);
});
