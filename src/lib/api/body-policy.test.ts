import { beforeAll, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { auditBodyPolicy, bodyPolicyProblems, type BodyAudit } from "../../../test-support/body-policy";

// The unseeded tree is audited once for the file; a case that seeds a defect
// audits its own sources.
let tree: BodyAudit;
beforeAll(() => { tree = auditBodyPolicy(); });
it("excludes raw request bodies by type and matches enforced and documented policies both ways", () => {
  const audit = tree;
  expect(audit.policies.length).toBeGreaterThan(50);
  expect(bodyPolicyProblems(audit, buildOpenApiDocument())).toEqual([]);
});

const rawSeeds: [string, Record<string, string>][] = [
  ["two-hop helper", {
    "src/app/api/maps/route.ts": 'import { first } from "@/lib/body-seed-first"; export async function POST(parcel: Request) { return Response.json(await first(parcel)); }',
    "src/lib/body-seed-first.ts": 'import { second } from "./body-seed-second"; export function first(envelope: Request) { return second(envelope); }',
    "src/lib/body-seed-second.ts": 'export function second(letter: Request) { const alias = letter; return alias.json(); }',
  }],
  ["renamed request parameter", { "src/app/api/maps/route.ts": 'export async function POST(parcel: Request) { return Response.json(await parcel.json()); }' }],
  ["request clone", { "src/app/api/maps/route.ts": 'export async function POST(parcel: Request) { const duplicate = parcel.clone(); return Response.json(await duplicate.json()); }' }],
  ["stream conversion", { "src/app/api/maps/route.ts": 'import { Readable } from "node:stream"; export async function POST(parcel: Request) { Readable.fromWeb(parcel.body as import("node:stream/web").ReadableStream); return Response.json({}); }' }],
];
it.each(rawSeeds)("independently rejects the %s mutation by receiver type", (_label, seed) => {
  const audit = auditBodyPolicy(seed);
  expect(audit.violations.some(problem => problem.includes("raw Request body member"))).toBe(true);
  expect(bodyPolicyProblems(audit, buildOpenApiDocument()).length).toBeGreaterThan(0);
});
it("rejects a raw SDK handoff independently of route discovery", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/lib/mcp/handler.ts", "utf8");
  const audit = auditBodyPolicy({ "src/lib/mcp/handler.ts": source.replace("await boundedMcpRequest(request)", "request") });
  expect(audit.violations.some(problem => problem.includes("unbounded Request passed to an external consumer"))).toBe(true);
  expect(bodyPolicyProblems(audit, buildOpenApiDocument())).toContain("post /api/mcp: documented byte policy 16777216/request_body_too_large differs from enforced undefined/undefined");
});
it("rejects a removed bound even when no raw body is read", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/maps/route.ts", "utf8");
  const audit = auditBodyPolicy({ "src/app/api/maps/route.ts": source.replace("largeJsonValue(request)", "Promise.resolve({})") });
  expect(audit.violations).toEqual([]);
  expect(bodyPolicyProblems(audit, buildOpenApiDocument())).toContain("post /api/maps: documented byte policy 16777216/request_body_too_large differs from enforced undefined/undefined");
});
it("rejects stale descriptions and undocumented policies, including assistant's own code", () => {
  const audit = tree, document = buildOpenApiDocument();
  document.paths["/api/assistant/messages"].post.description = "At most 16,777,216 wire bytes";
  delete (document.paths as Record<string, unknown>)["/api/maps"];
  const problems = bodyPolicyProblems(audit, document);
  expect(problems).toContain("post /api/assistant/messages: stale byte policy description");
  expect(problems).toContain("post /api/maps: enforced byte policy is undocumented");
});
it("permits upstream Response reads and classifies binary and multipart outside JSON", () => {
  const audit = auditBodyPolicy({ "src/lib/body-response-control.ts": 'export async function upstream(reply: Response) { const alias = reply; return alias.json(); }' });
  expect(audit.violations).toEqual([]);
  expect(audit.policies.some(policy => policy.path === "/api/maps/{id}/thumbnail" || policy.path === "/api/tables" && policy.method === "post")).toBe(false);
  expect(bodyPolicyProblems(audit, buildOpenApiDocument())).toEqual([]);
});
