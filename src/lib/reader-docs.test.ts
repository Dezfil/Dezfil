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
    ["docs/start/install.md", "setup"], ["CHANGELOG.md", "recorded original account"], ["docs/api/mcp.md", "API / MCP tokens"],
    ["docs/api/http-api.md", "Reload"], ["docs/use/share-and-publish.md", "Anyone with the link, without an account"], ["docs/self-host/backup-and-restore.md", "DEZFIL_SECRET_KEY"],
  ]) expect(read(file), `${file}: ${term}`).toContain(term);
});

it("distinguishes deployment settings from persisted preferences and the model catalogue", () => {
  const configuration = read("docs/self-host/configuration.md");
  expect(configuration).not.toMatch(/configured entirely through environment|nothing is stored in the database|nothing can be\s+changed at runtime/);
  for (const term of ["account preferences", "not instance settings", "assistant-models.json", "restart", "Settings"]) expect(configuration).toContain(term);
});

it("gives operators complete restoration and credential recovery instructions", () => {
  const backup = read("docs/self-host/backup-and-restore.md"), api = read("docs/api/http-api.md");
  const users = read("docs/self-host/users.md"), share = read("docs/use/share-and-publish.md"), changelog = read("CHANGELOG.md");
  // The link lifetime, the project roles and what a restore brings back sit
  // on the page of the task they belong to; the author of changes made
  // before the ownership upgrade is the changelog's, which says what changed.
  for (const [page, text, term] of [
    ["users", users, "7 days"], ["share", share, "Viewer"], ["share", share, "Editor"], ["changelog", changelog, "**Unknown** as the author"],
    ["backup", backup, "password hash"], ["backup", backup, "tokens revoked since work again"],
  ]) expect(text.replace(/\s+/g, " "), `${page}: ${term}`).toContain(term);
  // The backup and the restore commands have one home; the admin recovery
  // commands sit with the recovery they start, on Users, with the link's
  // lifetime, the wait on a busy store and what a takeover leaves; a
  // script's chained revision example is on How the API works.
  for (const term of ["\n## Back up\n", "\n## Restore\n", "mkdir \"$HOME/dezfil-backup\" &&", "cp -a /data/. /backup/", "&& echo Restored"]) expect(backup).toContain(term);
  for (const term of ["\n## Recover the admin account\n", "npm run admin:recover --", "docker exec -it", "docker run --rm -it", "--data-dir", "--origin", "--email"]) expect(users).toContain(term);
  for (const term of ["within 15 minutes", "stayed busy for five seconds", "took over the instance"]) expect(users.replace(/\s+/g, " ")).toContain(term);
  for (const term of ["X-Edit-Revision", "current.editRevision"]) expect(api).toContain(term);
});

it("opens no file an operator's command touches to every user on the host", () => {
  const pages = execFileSync("git", ["ls-files", "-z", "docs/self-host", "docs/start"], { encoding: "utf8" }).split("\0").filter((file) => file.endsWith(".md"));
  expect(pages.length).toBeGreaterThan(5);
  for (const page of pages) expect(read(page), page).not.toMatch(/chmod\s+(?:-R\s+)?(?:[ugo]*a[ugo]*|o)\+[rx]*w|chmod\s+(?:-R\s+)?[0-7]?[0-7][0-7][2367]\b/);
  // Chromium's trust stores belong to the user Dezfil runs as, and to no one else.
  const egress = read("docs/self-host/what-leaves-the-instance.md");
  for (const term of ["chown -R node:node legacy-nss current-nss", "chmod 700 legacy-nss current-nss"]) expect(egress).toContain(term);
});
