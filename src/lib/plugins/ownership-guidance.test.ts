import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { GUIDANCE_SECTIONS, analyticalGuidance } from "@/lib/assistant/guidance";
import { buildOpenApiDocument } from "@/lib/api/openapi";

it("carries the same ownership and SQL boundary into the assistant and generated package", () => {
  const section = GUIDANCE_SECTIONS.find(value => value.id === "private-space");
  expect(section).toBeDefined(); expect(section?.audience).toBe("shared");
  expect(section?.text).toContain("account's own datasets");
  expect(section?.text).toContain("File readers");
  expect(section?.text).toContain("PROJ");
  expect(section?.text).toContain("sql_rejected");
  expect(section?.text).toContain("EPSG");
  for (const text of [analyticalGuidance(), readFileSync("plugins/dezfil/skills/dezfil/analysis.md", "utf8")]) {
    expect(text.split(section!.text)).toHaveLength(2);
  }
});
it("describes private work in the published API introduction", () => {
  const description = buildOpenApiDocument().info.description;
  expect(description).toContain("private to the authenticated account");
  expect(description).toContain("Administrators");
  expect(description).toContain("owner-local");
});
it("removes the obsolete shared-data upgrade claim and documents local draft disposal", () => {
  const readme = readFileSync("README.md", "utf8");
  expect(readme).not.toContain("Signed-in accounts still share the same maps");
  expect(readme).toContain("Each account's maps");
  const runbook = readFileSync("docs/runbook.md", "utf8");
  expect(runbook).toContain("Unlabelled browser SQL drafts");
  expect(runbook).toContain("recorded original account");
  expect(runbook).toContain("File-referencing PROJ");
});
