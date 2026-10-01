import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("documents history under the map's reach, owner-only thumbnails and atomic replay refusal", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  for (const suffix of ["history", "undo", "redo", "thumbnail"]) {
    for (const operation of Object.values(document.paths[`/api/maps/{id}/${suffix}`])) {
      expect(operation.description).toContain("History follows its map: everyone who reaches the map reads its availability");
      expect(operation.description).toContain("Thumbnails are the map owner's: captured by the owner and served to the owner alone");
      expect(operation.responses).toHaveProperty("404");
    }
  }
  for (const name of ["get_history", "undo_change", "redo_change"]) {
    expect(buildTools().find(tool => tool.name === name)!.description).toContain("leave history and artifacts unchanged");
  }
});
