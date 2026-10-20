import { readFileSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { gateRequest } from "@/lib/auth/gate";
import { requireRequestAuth } from "@/lib/auth/http";
import { createApiToken } from "@/lib/auth/credentials";
import { mapsOverview } from "@/lib/map-service";
import { GUIDANCE_SECTIONS } from "@/lib/assistant/guidance";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const base = "http://127.0.0.1:3231";
let db: Database, token: string;
function example(file: string) {
  const source = readFileSync(file, "utf8").match(/<!-- revision-example -->\s*```js\n([\s\S]*?)\n```/);
  expect(source, file + " executable revision example").not.toBeNull();
  return source![1];
}
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); vi.stubEnv("PORT", "3231");
  const context = requireRequestAuth(testAccountRequest(new Request(base + "/api/account"), db));
  token = createApiToken(context, "Examples", db).secret;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input, init));
    const gate = gateRequest(new NextRequest(request.clone()));
    return gate.headers.get("x-middleware-next") === "1" ? dispatchAssistantTestRoute(request) : gate;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });

it.each(["docs/api/http-api.md", "docs/api/mcp.md"])("executes %s with two accepted writes and detects omitted revisions", async file => {
  const source = example(file);
  const run = (code: string) => new AsyncFunction("base", "token", "fetch", code)(base, token, fetch);
  await run(source);
  const maps = await mapsOverview(testAccountScope(db));
  expect(maps).toHaveLength(1); expect(maps[0]).toMatchObject({ name: "Survey map", basemap: "light" });
  const withoutRevision = source.replaceAll('"X-Edit-Revision": current.editRevision', '"X-Edit-Revision": ""').replaceAll('expected_revision: current.editRevision', 'expected_revision: ""');
  expect(withoutRevision).not.toBe(source);
  await expect(run(withoutRevision)).rejects.toThrow(/invalid_request/);
  const staleChain = source.replace(/current = await (request|call)\(([^\n]+)name: "Survey map"([^\n]+)\);/, 'await $1($2name: "Survey map"$3);');
  expect(staleChain).not.toBe(source);
  await expect(run(staleChain)).rejects.toThrow(/stale_revision/);
});

it("gives external tools the enforced revision and recovery contract", () => {
  const section = GUIDANCE_SECTIONS.find(section => section.id === "edit-revisions" && section.audience === "package");
  for (const term of ["expected_revision", "editRevision", "stale_revision", "new edit", "order"]) expect(section?.text).toContain(term);
  expect(readFileSync("plugins/dezfil/skills/dezfil/analysis.md", "utf8")).toContain(section?.text);
  expect(readFileSync("docs/api/http-api.md", "utf8")).not.toContain("Write preconditions are not yet required");
});
