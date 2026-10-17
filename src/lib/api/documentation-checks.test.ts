import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { checkContractDocs } from "../../../scripts/check-contract-docs.mjs";
import { checkReaderDocs } from "../../../scripts/check-reader-docs.mjs";

const document = buildOpenApiDocument(), tools = buildTools();
const read = (file: string) => readFileSync(file, "utf8");
const docs = { api: read("docs/reference/http-api.md"), mcp: read("docs/reference/mcp.md"), proof: read("docs/develop/verification/account-deletion-guidance.md") };
const bump = (text: string, pattern: RegExp) => text.replace(pattern, match => match.replace(/\d+/, number => String(Number(number) + 1)));
const countSeeds: [string, "api" | "mcp", RegExp][] = [
  ["paths", "api", /\d+ paths/], ["operations", "api", /\d+ operations/],
  ["schemas", "api", /\d+ named\s+component schemas/], ["errors", "api", /There are \*\*\d+\*\* codes/],
  ["MCP operations", "mcp", /Documented operations \| \d+/],
  ["tools", "mcp", /Operations that become tools \| \d+/],
  ["exclusions", "mcp", /Deliberately excluded \| \d+/],
  ["JSON readers", "api", /Measured JSON reader operations: \*\*\d+\*\*/],
];
it("checks actual reader-facing counts and catalogue against the served contract and tools", () => {
  expect(checkContractDocs(document, tools, docs)).toEqual([]);
});
it.each(countSeeds)("rejects a stale reader-facing %s count", (_label, key, pattern) => {
  const seeded = { ...docs, [key]: bump(docs[key], pattern) };
  expect(seeded[key]).not.toBe(docs[key]);
  expect(checkContractDocs(document, tools, seeded).length).toBeGreaterThan(0);
});
it.each(["missing", "extra", "meaning", "duplicate"])("rejects a seeded %s error catalogue entry", mode => {
  const row = docs.api.match(/^\| `stale_revision` \|.*$/m)![0];
  const change = mode === "missing" ? "" : mode === "extra" ? row + "\n| `invented_error` | Invented. |" : mode === "duplicate" ? row + "\n" + row : row.replace("Reload", "Ignore");
  const seeded = { ...docs, api: docs.api.replace(row, change) };
  expect(checkContractDocs(document, tools, seeded).length).toBeGreaterThan(0);
});
it("rejects source enum/catalogue disagreement and a dropped generated tool", () => {
  const changed = structuredClone(document);
  changed.components.schemas.Error.properties.error.properties.code.enum.pop();
  expect(checkContractDocs(changed, tools, docs).length).toBeGreaterThan(0);
  expect(checkContractDocs(document, tools.slice(1), docs).length).toBeGreaterThan(0);
});
const readers = Object.fromEntries(["README.md", "AGENTS.md", "docs/reference/configuration.md", "docs/operate/self-hosting.md", "docs/operate/runbook.md", "docs/reference/http-api.md", "docs/reference/mcp.md", "docs/start/run-it.md", "docs/guides/templates.md", "docs/reference/sql-limits.md", "docs/develop/checks-and-testing.md", "plugins/dezfil/skills/dezfil/analysis.md", "src/components/settings/WorkspaceCard.tsx"].map(file => [file, read(file)]));
it("accepts the shipped reader guidance", () => { expect(checkReaderDocs(readers)).toEqual([]); });
it.each([
  ["docs/reference/configuration.md", "Dezfil is configured entirely through environment variables."],
  ["AGENTS.md", "Local accounts exist; fuller account documentation follows."],
  ["README.md", "Dezfil has no accounts. Authoring APIs are open."],
  ["docs/reference/http-api.md", "Write preconditions are not yet required."],
  ["src/components/settings/WorkspaceCard.tsx", '"Members & sharing" coming soon'],
])("rejects superseded copy in %s", (file, text) => {
  expect(checkReaderDocs({ ...readers, [file]: readers[file] + "\n" + text }).length).toBeGreaterThan(0);
});
it.each(["docs/reference/http-api.md", "docs/reference/mcp.md"])("rejects a missing revision in the actual %s example", file => {
  const changed = readers[file].replace('"X-Edit-Revision": current.editRevision', '"ignored": current.editRevision').replace('expected_revision: current.editRevision', 'ignored: current.editRevision');
  expect(changed).not.toBe(readers[file]);
  expect(checkReaderDocs({ ...readers, [file]: changed }).length).toBeGreaterThan(0);
});

it("keeps repeated contract builds stable and automatic Allow schemas exact", () => {
  const first = buildOpenApiDocument(), second = buildOpenApiDocument();
  expect(second).toEqual(first);
  for (const operations of Object.values(second.paths)) {
    const allowed = Object.keys(operations).map(method => method.toUpperCase()).sort().join(", ");
    const automatic = operations as unknown as Record<string, { "x-tool": unknown; responses: Record<string, { headers?: { Allow: { schema: { const: string } } } }> }>;
    expect(automatic.options["x-tool"]).toBe(false);
    expect(automatic.options.responses["204"].headers?.Allow.schema.const).toBe(allowed);
    if (automatic.get) expect(automatic.head["x-tool"]).toBe(false);
  }
});

it("measures JSON reader counts and rejects a stale tier independently", () => {
  const changed = structuredClone(document);
  const body = changed.paths["/api/maps"].post.requestBody as Record<string, unknown>;
  body["x-byte-limit"] = 65_536;
  // One more than whatever the reader says, so the seed is stale by one.
  const said = Number(docs.api.match(/^\| 65,536 \| (\d+) \|$/m)![1]);
  expect(checkContractDocs(changed, tools, docs)).toContain(`JSON tier 65536 readers: reader says ${said}, contract requires ${said + 1}`);
  const missingBusy = { ...docs, api: docs.api.replace(/^\| `authentication_busy` \|.*\n/m, "") };
  expect(checkContractDocs(document, tools, missingBusy)).toContain("Reader error catalogue has missing or extra codes");
});

it("rejects a served actor union that drops deleted actors without changing counts", () => {
  const changed = structuredClone(document);
  changed.components.schemas.RecipeRun.properties.runner.oneOf.splice(1, 1);
  expect(checkContractDocs(changed, tools, docs)).toContain("Actor schema differs: RecipeRun.runner");
});
it("rejects stale actor guidance in the actual reader", () => {
  const seeded = { ...docs, mcp: docs.mcp.replaceAll("{ deleted: true }", "null") };
  expect(checkContractDocs(document, tools, seeded)).toContain("MCP actor guidance omits the deleted variant");
});
it("does not describe deletion as unavailable", () => {
  expect(read("docs/operate/runbook.md")).not.toContain("The deletion operations are not exposed yet.");
});

it("rejects a stale count in the outside proof guide", () => {
  // One more path than the guide says, whatever it says today.
  const seeded = { ...docs, proof: docs.proof.replace(/(\d+) paths/, (_, paths: string) => `${Number(paths) + 1} paths`) };
  expect(seeded.proof).not.toBe(docs.proof);
  expect(checkContractDocs(document, tools, seeded)).toContain("Proof guide counts differ from contract");
});
