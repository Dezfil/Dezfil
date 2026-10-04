import { expect, it } from "vitest";
import { buildTools } from "./tools";

it.each(["create_postgis_connection", "update_postgis_connection"])("keeps %s URL guidance concise with the refusal sentence and API guide", (name) => {
  const tool = buildTools().find((tool) => tool.name === name)!;
  const { description } = tool.inputSchema.properties.url as { description: string };
  // URL guidance travels in every tool listing and assistant request.
  expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(1400);
  expect(description).toContain("before source contact or explicit-field overrides");
  expect(description).toContain("HTTP 400 invalid_request");
  expect(description).toContain("This connection string uses the unsupported protection parameter channel_binding; Dezfil supports connection fields and SSL required or not required.");
  expect(description).toContain("Saved connections are not rechecked because their original string was never stored.");
  expect(description).toContain("docs/api.md");
});
