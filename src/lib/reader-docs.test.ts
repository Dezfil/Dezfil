import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read = (path: string) => readFileSync(path, "utf8");

it("keeps every probe's procedure beside the script it runs, and out of the pages", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const probes = Object.entries(scripts).filter(([name]) => name.startsWith("probe:"));
  expect(probes.length).toBeGreaterThan(5);
  const pages = execFileSync("git", ["ls-files", "-z", "docs"], { encoding: "utf8" }).split("\0").filter((file) => file.endsWith(".md"));
  expect(pages.length).toBeGreaterThan(5);
  for (const [name, command] of probes) {
    const script = /^node (scripts\/[a-z0-9-]+)\.mjs$/.exec(command)?.[1];
    expect(script, name).toBeDefined();
    expect(existsSync(`${script}.md`), `${name}: ${script}.md`).toBe(true);
    for (const page of pages) expect(read(page), `${page} names ${name}`).not.toMatch(new RegExp(`${name}(?![a-z0-9-])`));
  }
});

it("keeps the product boundary and setup instructions current", () => {
  const brief = read("AGENTS.md").split("## Out of scope for now")[1];
  for (const term of ["Local accounts", "private ownership", "project sharing", "stale", "SSO", "audit logs", "finer grants"]) expect(brief).toContain(term);
  expect(brief).not.toMatch(/fuller .*documentation follows/);
  // The README's run, account, token, revision and key paragraphs now live on these pages.
  for (const [file, term] of [
    ["docs/start/install.md", "setup"], ["docs/self-host/what-leaves-the-instance.md", "original account"], ["docs/api/mcp.md", "API / MCP tokens"],
    ["docs/api/http-api.md", "Reload"], ["docs/self-host/what-leaves-the-instance.md", "Published links remain readable"], ["docs/self-host/what-leaves-the-instance.md", "DEZFIL_SECRET_KEY"],
  ]) expect(read(file), `${file}: ${term}`).toContain(term);
});

it("distinguishes deployment settings from persisted preferences and the model catalogue", () => {
  const configuration = read("docs/self-host/configuration.md");
  expect(configuration).not.toMatch(/configured entirely through environment|nothing is stored in the database|nothing can be\s+changed at runtime/);
  for (const term of ["account preferences", "instance preferences", "assistant-models.json", "restart", "Settings"]) expect(configuration).toContain(term);
});

it("gives operators complete restoration and credential recovery instructions", () => {
  const guide = read("docs/self-host/what-leaves-the-instance.md"), runbook = read("docs/self-host/backup-and-restore.md");
  for (const term of ["seven days", "Viewer", "Editor", "Unknown", "initiator", "plaintext", "backed-up validity", "fifteen minutes", "five seconds", "hostile setup"]) expect(guide.replace(/\s+/g, " ")).toContain(term);
  for (const term of ["## Full backup and restore", "## Admin account recovery", "npm run admin:recover --", "docker exec -it", "docker run --rm -it", "--data-dir", "--origin", "--email", "X-Edit-Revision", "jq -er '.editRevision'"]) expect(runbook).toContain(term);
});
