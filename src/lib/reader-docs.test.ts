import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read = (path: string) => readFileSync(path, "utf8");

it("keeps the product boundary and setup instructions current", () => {
  const brief = read("AGENTS.md").split("## Out of scope for now")[1];
  for (const term of ["Local accounts", "private ownership", "project sharing", "stale", "SSO", "audit logs", "finer grants"]) expect(brief).toContain(term);
  expect(brief).not.toMatch(/fuller .*documentation follows/);
  const readme = read("README.md");
  for (const term of ["setup", "original account", "API / MCP tokens", "Reload", "published", "DEZFIL_SECRET_KEY"]) expect(readme).toContain(term);
});

it("distinguishes deployment settings from persisted preferences and the model catalogue", () => {
  const configuration = read("docs/configuration.md");
  expect(configuration).not.toMatch(/configured entirely through environment|nothing is stored in the database|nothing can be\s+changed at runtime/);
  for (const term of ["account preferences", "instance preferences", "assistant-models.json", "restart", "Settings"]) expect(configuration).toContain(term);
});

it("gives operators complete restoration and credential recovery instructions", () => {
  const guide = read("docs/self-hosting.md"), runbook = read("docs/runbook.md");
  for (const term of ["seven days", "Viewer", "Editor", "Unknown", "initiator", "plaintext", "backed-up validity", "fifteen minutes", "five seconds", "hostile setup"]) expect(guide.replace(/\s+/g, " ")).toContain(term);
  for (const term of ["## Full backup and restore", "## Admin account recovery", "npm run admin:recover --", "docker exec -it", "docker run --rm -it", "--data-dir", "--origin", "--email", "X-Edit-Revision", "jq -er '.editRevision'"]) expect(runbook).toContain(term);
});
