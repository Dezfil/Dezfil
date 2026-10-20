import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The documentation gate is named wherever the gates are: as a package
 * script, as a step of the pipeline's checks job, in the coding agents'
 * brief, in the contributing guide and as a row of Development setup's
 * table of gates.
 * The brief also sends an agent to the documentation index before it
 * touches a page or a behavior a page describes, and the README's
 * Documentation section links the site and the index.
 */
const read = (file: string) => readFileSync(file, "utf8");

/** The lines of one top-level job of the pipeline, its header to the next job's. */
function job(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, at) => at > start && /^ {2}[a-z][\w-]*:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** A markdown section from its heading to the next heading of its level or higher. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex(line => line.replace(/^#+\s*/, "") === heading && /^#+\s/.test(line));
  expect(start, heading).toBeGreaterThan(-1);
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex((line, at) => at > start && new RegExp(`^#{1,${level}}\\s`).test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the documentation gate is listed with the others", () => {
  it("is a package script", () => {
    expect(JSON.parse(read("package.json")).scripts["lint:docs"]).toBe("node scripts/docs.mjs --check");
  });

  it("runs in the pipeline's checks job", () => {
    expect(job(read(".github/workflows/ci.yml"), "checks")).toMatch(/^\s+- run: npm run lint:docs$/m);
  });

  it("is in the agents' brief, the contributing guide and Development setup's table of gates", () => {
    expect(section(read("AGENTS.md"), "Working in this repository")).toContain("`lint:docs`");
    expect(section(read("CONTRIBUTING.md"), "Run the gates")).toMatch(/^npm run lint:docs\b/m);
    expect(section(read("docs/contribute/development-setup.md"), "Run the checks")).toMatch(/^\| `lint:docs` \|/m);
  });
});

describe("the retired-path gate is listed with the others", () => {
  it("is a package script", () => {
    expect(JSON.parse(read("package.json")).scripts["lint:retired-paths"]).toBe("node scripts/check-retired-paths.mjs");
  });

  it("runs in the pipeline's checks job", () => {
    expect(job(read(".github/workflows/ci.yml"), "checks")).toMatch(/^\s+- run: npm run lint:retired-paths$/m);
  });

  it("is in the agents' brief, the contributing guide and Development setup's table of gates", () => {
    expect(section(read("AGENTS.md"), "Working in this repository")).toContain("`lint:retired-paths`");
    expect(section(read("CONTRIBUTING.md"), "Run the gates")).toMatch(/^npm run lint:retired-paths\b/m);
    expect(section(read("docs/contribute/development-setup.md"), "Run the checks")).toMatch(/^\| `lint:retired-paths` \|/m);
  });
});

describe("the ways into the documentation", () => {
  it("the agents' brief points at the index in its first lines", () => {
    const opening = read("AGENTS.md").split("\n").slice(0, 15).join("\n");
    expect(opening).toContain("(docs/README.md)");
  });

  it("the README's Documentation section links the site and the index", () => {
    const documentation = section(read("README.md"), "Documentation");
    expect(documentation).toContain("(https://dezfil.io/docs/)");
    expect(documentation).toContain("(docs/README.md)");
  });
});
