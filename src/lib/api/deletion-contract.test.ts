import { expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { buildOpenApiDocument } from "./openapi";
it("exposes deletion through the shared tool catalogue with erasure consequences and explicit unfinished states", () => {
  const tools = buildTools();
  for (const name of ["preview_user_deletion", "delete_user", "get_user_deletion", "finish_user_deletion"]) {
    const tool = tools.find(tool => tool.name === name); expect(tool, name).toBeDefined();
    expect(tool!.description).toContain("current admin"); expect(tool!.description).toContain("private, no-store");
    expect(tool!.effects.readOnly).toBe(name.startsWith("preview") || name.startsWith("get"));
    expect(tool!.confirm).toBe(!tool!.effects.readOnly);
    if (!tool!.effects.readOnly) {
      expect(tool!.mcp?.destructiveHint).toBe(true); expect(tool!.confirmation?.consequence).toContain("permanently");
      expect(tool!.confirmation?.consequence).toContain("links");
      expect(tool!.display.verb).not.toContain("Deleted");
      for (const term of ["SQL name", "backups", "caches", "needs-retry", "Finish deleting"]) expect(tool!.description).toContain(term);
    }
  }
  const doc = buildOpenApiDocument();
  expect(doc.components.schemas.Users.properties).toHaveProperty("deletions");
  const deletion = tools.find(t => t.name === "delete_user")!;
  expect(deletion.bodyKeys.sort()).toEqual(["confirm", "confirmation", "email"]);
  expect(JSON.stringify(deletion.rawOutputSchema)).toContain("needs-retry");
});
