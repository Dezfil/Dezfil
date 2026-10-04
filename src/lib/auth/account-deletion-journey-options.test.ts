import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  { command: process.execPath, args: ["scripts/account-deletion-driver.mjs", "--seed", "module-local"], status: 1, error: "Unknown option '--seed'" },
  { command: "sh", args: ["scripts/account-deletion-image.sh", "dezfil:ci", "module-local"], status: 2, error: "Usage: account-deletion-image.sh [image]" },
])("rejects the unsupported journey seed before starting $command", ({ command, args, status, error }) => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "journey-options-"));
  // A populated root also prevents the former argument parser from starting
  // a process or container when this regression test runs against that parser.
  writeFileSync(path.join(directory, "occupied"), "argument-check-only");
  try {
    const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, DEZFIL_DATA_DIR: directory }, timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toContain(error);
    expect(result.stdout).not.toContain("PASS:");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
