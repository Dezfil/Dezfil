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
import { REVISION_EXAMPLE } from "../../../scripts/check-reader-docs.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const base = "http://127.0.0.1:3231";
let db: Database, token: string;
function example(file: string) {
  const source = readFileSync(file, "utf8").match(REVISION_EXAMPLE);
  expect(source, file + " executable revision example").not.toBeNull();
  return source![1];
}
/** Run an example as its reader does. One that declares its own address
 * and token runs as the file it is: with the token in place of
 * <YOUR_TOKEN>, or with DEZFIL_API_TOKEN set to it, as the reader set it
 * once for their MCP client. One that declares neither is given both. */
function runExample(code: string) {
  if (/^const base = /m.test(code)) {
    if (code.includes("const token = process.env.DEZFIL_API_TOKEN;")) {
      vi.stubEnv("DEZFIL_API_TOKEN", token);
      return new AsyncFunction("fetch", code)(fetch);
    }
    expect(code, "the example takes the token in place of <YOUR_TOKEN>").toContain('const token = "<YOUR_TOKEN>";');
    return new AsyncFunction("fetch", code.replace('"<YOUR_TOKEN>"', JSON.stringify(token)))(fetch);
  }
  return new AsyncFunction("base", "token", "fetch", code)(base, token, fetch);
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

const REVISION = /\b[0-9a-f]{32}\b/;
const REVISIONS = new RegExp(REVISION.source, "g");

it.each(["docs/api/http-api.md", "docs/api/mcp.md"])("executes %s with two accepted writes and detects omitted revisions", async file => {
  const source = example(file);
  const log = vi.spyOn(console, "log");
  await runExample(source);
  const printed = log.mock.calls.map(args => args.join(" "));
  // The page runs the example by the name its block is titled with, and its
  // Output is what the example prints, but for the revision, which is new on
  // every run and has the shape the page shows.
  const text = readFileSync(file, "utf8");
  const title = /<!-- revision-example -->\s*```js title="([^"\n]+)"/.exec(text)?.[1];
  expect(title, file + " titles its example with the file a reader saves").toMatch(/^[\w-]+\.mjs$/);
  const shown = new RegExp(`\`\`\`sh title="Terminal"\nnode ${title!.replace(".", "\\.")}\n\`\`\`\\s*\`\`\`text title="Output"\n([^\n]+)\n\`\`\``).exec(text)?.[1];
  expect(shown, file + " shows what the example prints").toMatch(REVISION);
  expect(printed.join("\n").replace(REVISIONS, "<REVISION>")).toBe(shown!.replace(REVISIONS, "<REVISION>"));
  const maps = await mapsOverview(testAccountScope(db));
  expect(maps).toHaveLength(1); expect(maps[0]).toMatchObject({ name: "Survey map", basemap: "light" });
  const withoutRevision = source.replaceAll('"X-Edit-Revision": current.editRevision', '"X-Edit-Revision": ""').replaceAll('expected_revision: current.editRevision', 'expected_revision: ""');
  expect(withoutRevision).not.toBe(source);
  await expect(runExample(withoutRevision)).rejects.toThrow(/invalid_request/);
  const staleChain = source.replace(/current = await (request|call)\(([^\n]+)name: "Survey map"([^\n]+)\);/, 'await $1($2name: "Survey map"$3);');
  expect(staleChain).not.toBe(source);
  await expect(runExample(staleChain)).rejects.toThrow(/stale_revision/);
});

it("gives external tools the enforced revision and recovery contract", () => {
  const section = GUIDANCE_SECTIONS.find(section => section.id === "edit-revisions" && section.audience === "package");
  for (const term of ["expected_revision", "editRevision", "stale_revision", "new edit", "order"]) expect(section?.text).toContain(term);
  expect(readFileSync("plugins/dezfil/skills/dezfil/analysis.md", "utf8")).toContain(section?.text);
  expect(readFileSync("docs/api/http-api.md", "utf8")).not.toContain("Write preconditions are not yet required");
});
