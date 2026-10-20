import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { GUIDANCE_SECTIONS, analyticalGuidance } from "@/lib/assistant/guidance";
import { systemPrompt } from "@/lib/assistant/prompt";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const analysis = () => readFileSync("plugins/dezfil/skills/dezfil/analysis.md", "utf8");

it("carries the same ownership, sharing and SQL boundary into the assistant and generated package", () => {
  expect(GUIDANCE_SECTIONS.find(value => value.id === "private-space")).toBeUndefined();
  const section = GUIDANCE_SECTIONS.find(value => value.id === "ownership-and-sharing");
  expect(section).toBeDefined(); expect(section?.audience).toBe("shared");
  // The sharing model: one owner, the project as the one boundary, the roles.
  expect(section?.text).toContain("private to its owner, administrators included, unless a project shares it");
  expect(section?.text).toContain("a project's owner gives people the viewer or editor role");
  expect(section?.text).toContain("connections are never shared");
  // Addressing: the SQL name, the qualified form and the SQL home.
  expect(section?.text).toContain("<sql name>.<dataset>");
  expect(section?.text).toContain("SQL home");
  expect(section?.text).not.toContain("private to the authenticated account");
  expect(section?.text).not.toContain("account's own datasets");
  // The file and PROJ policy is unchanged.
  expect(section?.text).toContain("File readers");
  expect(section?.text).toContain("PROJ");
  expect(section?.text).toContain("sql_rejected");
  expect(section?.text).toContain("EPSG");
  for (const text of [analyticalGuidance(), analysis()]) {
    expect(text.split(section!.text)).toHaveLength(2);
  }
});
it("tells the assistant how its page's SQL names each grounded table, and the package nothing about grounding", () => {
  const grounding = GUIDANCE_SECTIONS.find(value => value.id === "grounding");
  expect(grounding?.audience).toBe("assistant");
  expect(grounding?.text).toContain("homeName");
  // The prompt the loop hands a provider; that it reaches the provider whole
  // is held by the frozen package capture.
  const system = systemPrompt();
  expect(system).toContain("homeName: the name that page's own SQL uses for it");
  expect(system).not.toContain("SQL names resolve only to that account's own datasets");
  expect(analysis()).not.toContain("homeName");
});
it("describes ownership and sharing in the published API introduction", () => {
  const description = buildOpenApiDocument().info.description;
  expect(description).not.toContain("are private to the authenticated account");
  expect(description).toContain("private to its owner unless a project shares it: a project's owner gives people the viewer or editor role, and they reach the project and everything filed in it, whoever owns it.");
  expect(description).toContain("Administrators");
  expect(description).toContain("owner-local");
  expect(description).toContain("<sql name>.<dataset>");
});
it("removes the obsolete shared-data upgrade claim and documents local draft disposal", () => {
  for (const file of ["docs/self-host/users.md", "docs/self-host/what-leaves-the-instance.md"]) {
    expect(readFileSync(file, "utf8"), file).not.toContain("Signed-in accounts still share the same maps");
  }
  const users = readFileSync("docs/self-host/users.md", "utf8");
  expect(users).toContain("Each account's maps");
  expect(users.replace(/\s+/g, " ")).toContain("are private, including from admins, until a project's owner shares the project");
  // The upgrade's breaking SQL change and its draft disposal are changelog
  // entries; Upgrade says who owns the existing work after it.
  const changelog = readFileSync("CHANGELOG.md", "utf8").replace(/\s+/g, " ");
  expect(changelog).toContain("SQL drafts and history that a browser kept before accounts");
  expect(readFileSync("docs/self-host/upgrade.md", "utf8")).toContain("recorded original account");
  expect(changelog).toContain("File-referencing PROJ");
});
it("carries departure, deletion and explicit deleted actors in the generated guidance", () => {
  const section = GUIDANCE_SECTIONS.find(value => value.id === "account-departures");
  expect(section?.audience).toBe("shared");
  for (const text of [analyticalGuidance(), analysis()]) {
    expect(text).toContain(section?.text);
    expect(text).toContain("{ deleted: true }");
    expect(text).toContain("Finish deleting");
    expect(text).toContain("unattributed card images");
  }
});
