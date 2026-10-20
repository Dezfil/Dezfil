import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { checkContractDocs, readContractDocs } from "../../../scripts/check-contract-docs.mjs";
import { READER_FILES, checkReaderDocs } from "../../../scripts/check-reader-docs.mjs";

const document = buildOpenApiDocument(), tools = buildTools();
const read = (file: string) => readFileSync(file, "utf8");
const docs = readContractDocs() as { api: string; mcp: string; proof: string };
const bump = (text: string, pattern: RegExp) => text.replace(pattern, match => match.replace(/\d+/, number => String(Number(number) + 1)));
// Every count in the served contract proof's procedure. Each operation with
// its tool, each error code and each body limit is listed by the generated
// operation reference, which the documentation site holds to the
// description; neither API guide carries them.
const countSeeds: [string, "proof", RegExp][] = [
  ["paths", "proof", /\d+ paths/], ["operations", "proof", /\d+ operations/],
  ["schemas", "proof", /\d+ schemas/], ["errors", "proof", /\d+ error codes/],
  ["tools", "proof", /\d+ tools/], ["exclusions", "proof", /\d+ exclusions/],
  ["JSON readers", "proof", /\d+ JSON readers/],
];
it("checks actual reader-facing counts and change authors against the served contract and tools", () => {
  expect(checkContractDocs(document, tools, docs)).toEqual([]);
});
it.each(countSeeds)("rejects a stale reader-facing %s count", (_label, key, pattern) => {
  const seeded = { ...docs, [key]: bump(docs[key], pattern) };
  expect(seeded[key]).not.toBe(docs[key]);
  expect(checkContractDocs(document, tools, seeded).length).toBeGreaterThan(0);
});
it("leaves the per-operation lists to the operation reference: neither API guide states a count, tier or error table", () => {
  for (const anchor of [/\*\*\d+ paths,/, /There are \*\*\d+\*\* codes/, /Measured JSON reader operations/, /<!-- body-tiers:start -->/, /<!-- error-catalogue:start -->/,
    /\| Documented operations \| \d+/, /\| Operations that become tools \| \d+/, /\| Deliberately excluded \| \d+/, /editable-key input, [a-z-]+ keys/]) {
    expect(docs.api).not.toMatch(anchor);
    expect(docs.mcp).not.toMatch(anchor);
  }
});
it("rejects source enum/catalogue disagreement and a dropped generated tool", () => {
  const changed = structuredClone(document);
  changed.components.schemas.Error.properties.error.properties.code.enum.pop();
  expect(checkContractDocs(changed, tools, docs).length).toBeGreaterThan(0);
  expect(checkContractDocs(document, tools.slice(1), docs).length).toBeGreaterThan(0);
});
const readers = Object.fromEntries((READER_FILES as string[]).map(file => [file, read(file)]));
it("accepts the shipped reader guidance", () => { expect(checkReaderDocs(readers)).toEqual([]); });
it.each([
  ["docs/self-host/configuration.md", "Dezfil is configured entirely through environment variables."],
  ["AGENTS.md", "Local accounts exist; fuller account documentation follows."],
  ["README.md", "Dezfil has no accounts. Authoring APIs are open."],
  ["docs/api/http-api.md", "Write preconditions are not yet required."],
  ["src/components/settings/WorkspaceCard.tsx", '"Members & sharing" coming soon'],
])("rejects superseded copy in %s", (file, text) => {
  expect(checkReaderDocs({ ...readers, [file]: readers[file] + "\n" + text }).length).toBeGreaterThan(0);
});
it.each(["docs/api/http-api.md", "docs/api/mcp.md"])("rejects a missing revision in the actual %s example", file => {
  // Every occurrence: a page may name the revision outside its example too.
  const changed = readers[file].replaceAll('"X-Edit-Revision": current.editRevision', '"ignored": current.editRevision').replaceAll('expected_revision: current.editRevision', 'ignored: current.editRevision');
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

it("measures JSON reader tiers and rejects a stale tier in the proof procedure", () => {
  const changed = structuredClone(document);
  const body = changed.paths["/api/maps"].post.requestBody as Record<string, unknown>;
  body["x-byte-limit"] = 65_536;
  expect(checkContractDocs(changed, tools, docs)).toEqual(["Proof guide counts differ from contract"]);
});

it("rejects a served actor union that drops deleted actors without changing counts", () => {
  const changed = structuredClone(document);
  changed.components.schemas.RecipeRun.properties.runner.oneOf.splice(1, 1);
  expect(checkContractDocs(changed, tools, docs)).toContain("Actor schema differs: RecipeRun.runner");
});
it("rejects stale actor guidance in the actual reader", () => {
  const seeded = { ...docs, mcp: docs.mcp.replaceAll("{ deleted: true }", "null") };
  expect(checkContractDocs(document, tools, seeded)).toContain("MCP actor guidance omits the deleted variant");
  const api = { ...docs, api: docs.api.replaceAll("{ deleted: true }", "null") };
  expect(checkContractDocs(document, tools, api)).toContain("API actor guidance omits the deleted variant");
});
it.each([["api", "API"], ["mcp", "MCP"]] as const)("rejects a %s guide that stops saying a change's author can be a deleted account", (key, label) => {
  const seeded = { ...docs, [key]: docs[key].replace(/A\s+change's\s+author\s+can\s+be\s+a\s+deleted\s+account,\s+and\s+then\s+no\s+name\s+is\s+kept\./, "No name is kept.") };
  expect(seeded[key]).not.toBe(docs[key]);
  expect(checkContractDocs(document, tools, seeded)).toEqual([`${label} guide omits that a change's author can be a deleted account`]);
});
it("does not describe deletion as unavailable", () => {
  expect(read("docs/self-host/backup-and-restore.md")).not.toContain("The deletion operations are not exposed yet.");
});

it("rejects a stale count in the outside proof guide", () => {
  // One more path than the guide says, whatever it says today.
  const seeded = { ...docs, proof: docs.proof.replace(/(\d+) paths/, (_, paths: string) => `${Number(paths) + 1} paths`) };
  expect(seeded.proof).not.toBe(docs.proof);
  expect(checkContractDocs(document, tools, seeded)).toContain("Proof guide counts differ from contract");
});
