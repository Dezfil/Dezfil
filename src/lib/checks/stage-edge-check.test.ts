import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The stage-edge check covers the right edge: a second copy of the
 * right edge's expression outside its definition, or a second
 * `--stage-right` inside it, fails the check. Exercised on a fixture
 * tree so the seed never touches the real stylesheet: the script reads
 * `src/` under its working directory.
 */

const REPO = process.cwd();
const SCRIPT = path.join(REPO, "scripts/check-stage-edge.mjs");
const FILES = ["src/components/builder/MapBuilder.module.css", "src/components/builder/use-stage-edge.ts"];
/** The seeds, assembled at run time: the check scans this test's own
 * source too, and a literal copy here would be its own finding. */
const SEEDED_EXPRESSION = ["calc(var(--gutter)", "+ var(--assistant-offset))"].join(" ");
const SEEDED_DEFINITION = ["--stage-right", ": 0px"].join("");

function fixture(): string {
  const root = mkdtempSync(path.join(REPO, ".tmp-stage-edge-fixture-"));
  for (const file of FILES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(REPO, file), path.join(root, file));
  }
  return root;
}
function run(root: string): { code: number; output: string } {
  try {
    return { code: 0, output: execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe("check-stage-edge covers the right edge", () => {
  it("passes on the shipped definition", () => {
    const root = fixture();
    try {
      const { code, output } = run(root);
      expect(output).toContain("its right edge once");
      expect(code).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails on a seeded second copy of the right edge's expression in another stylesheet", () => {
    const root = fixture();
    try {
      writeFileSync(path.join(root, "src/components/builder/Seeded.module.css"), `.stage { right: ${SEEDED_EXPRESSION}; }\n`);
      const { code, output } = run(root);
      expect(code).toBe(1);
      expect(output).toContain("Seeded.module.css: writes the stage's right edge instead of reading var(--stage-right)");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails on a seeded second definition inside the definition file", () => {
    const root = fixture();
    try {
      const file = path.join(root, FILES[0]);
      writeFileSync(file, `${execFileSync("cat", [file], { encoding: "utf8" })}\n:global(body[data-map-full]) { ${SEEDED_DEFINITION}; }\n`);
      const { code, output } = run(root);
      expect(code).toBe(1);
      expect(output).toContain("the stage's right edge is defined 2 times in its own definition");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
