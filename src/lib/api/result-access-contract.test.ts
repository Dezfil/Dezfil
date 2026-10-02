import { resourceOperations } from "../../../test-support/api-route-inventory";
import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes account-bound result lifetime and the commit-time reach checks in the API and its generated tools", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; "x-tool": string | false; responses: unknown }>> };
  const tools = buildTools();
  for (const path of ["/api/maps/look", "/api/maps/look/{renderId}", "/api/maps/{id}/export/image", "/api/layers/{id}/export/{format}", "/api/query/export", "/api/projects/{id}/export"]) {
    for (const operation of resourceOperations(document.paths[path])) {
      expect(operation.description).toContain("initiating account through completion");
      expect(operation.description).toContain("even after the source or output is deleted");
      expect(operation.description).toContain("same refusal as an unknown identifier");
      expect(operation.description).toContain("A prepared layer download is refused on the claim when its layer, on a map the claimant does not own, or a dataset it drew that someone else owns has left the claimant's reach since the ticket");
      expect(operation.description).toContain("A server render and a look check ask at every phase whether the caller still reaches the map");
      expect(operation.description).toContain("A project export checks every selected member against the caller's reach as the archive completes and fails with export_failed naming the first one withdrawn rather than delivering a thinner archive");
      expect(operation.description).toContain("Results already issued (a query download, a retained look image, a project archive, an assistant answer) remain the initiator's for their retention lifetime after reach is withdrawn");
      expect(operation.responses).toHaveProperty("401");
      if (operation["x-tool"]) expect(tools.find(tool => tool.name === operation["x-tool"])?.description).toContain(operation.description);
    }
  }
  expect(document.paths["/api/assistant/runs/{id}"].get.description).toContain("deletion of any output");
});
