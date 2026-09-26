// The NUL-byte hygiene check must actually catch a NUL-carrying source
// file — and pass the repository as repaired. A check that cannot be
// shown red is not evidence.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/check-nul-bytes.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "dezfil-nul-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("node", [script, ...args], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status: number | null; stderr: string };
    return { code: err.status ?? -1, output: err.stderr };
  }
}

describe("NUL-byte hygiene check", () => {
  it("fails loudly on a file containing a NUL byte", () => {
    const bad = join(dir, "Bad.tsx");
    writeFileSync(bad, Buffer.from("const key = `a\0b`;\n"));
    const { code, output } = run([bad]);
    expect(code).toBe(1);
    expect(output).toContain("NUL byte");
    expect(output).toContain("Bad.tsx");
  });

  it("passes a clean file", () => {
    const good = join(dir, "Good.tsx");
    writeFileSync(good, "const key = `a\\nb`;\n");
    const { code } = run([good]);
    expect(code).toBe(0);
  });

  it("passes the whole repository as repaired (the regression)", () => {
    const { code, output } = run([]);
    expect(code).toBe(0);
    expect(output).toContain("PASS");
  });
});
