import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { filledIn, ownInstance, pageCalls, printedProblems, runScript, runShell, type OwnInstance, type PageBlock } from "@/lib/test-support/page-calls";

// Errors shows one failed call in a curl tab and a JavaScript tab, and a
// helper a reader saves and calls. They run here as a reader runs them,
// against an instance of their own, and each printed answer must be the one
// the page shows. The page's tables must name real codes and fields, cover
// every code the other API pages name, and give the status the instance
// answers for the codes made to happen here.

const PAGE = "docs/api/errors.md";
const ADDRESS = "http://localhost:3000";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };
/** The other API pages whose error codes a reader looks up here. */
const NAMING_PAGES = ["docs/api/quickstart.md", "docs/api/http-api.md"];

const page = readFileSync(PAGE, "utf8");
const document = buildOpenApiDocument();
const catalogue = document["x-error-codes"] as Record<string, string>;

let instance: OwnInstance | undefined;
afterEach(async () => { vi.useRealTimers(); await instance?.close(); instance = undefined; });

/** A new instance with the reader's account and a token. */
async function readerInstance(): Promise<string> {
  instance = await ownInstance(ADDRESS, "3452");
  const json = { "content-type": "application/json", origin: ADDRESS };
  const setup = await fetch(`${ADDRESS}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify(READER) });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.getSetCookie()[0].split(";")[0];
  const made = await fetch(`${ADDRESS}/api/account/tokens`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Script" }) });
  return (await made.json()).secret as string;
}

/** The block a page titles so. */
function block(text: string, title: string): PageBlock {
  const found = pageCalls(text).blocks.find((candidate) => candidate.title === title);
  expect(found, `${PAGE} shows a block titled ${title}`).toBeDefined();
  return found!;
}

/** The rows of every table under a second-level section: each row's cells. */
function tableRows(text: string, heading: string): string[][] {
  const section = text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
  expect(section, `${PAGE} has a section ${heading}`).toBeDefined();
  return section!.split("\n").filter((line) => line.startsWith("| `")).map((line) => line.slice(2, -2).split(" | "));
}

/** The code a cell names, from its first code span. */
const codeIn = (cell: string) => /^`([^`]+)`/.exec(cell)?.[1] ?? cell;

/** Every call of a copy of the page: the curl and JavaScript tabs of the
 * tab set, then the helper and the script that calls it. */
async function runPage(text: string, token: string): Promise<string[]> {
  const names = new Map<string, unknown>([["YOUR_TOKEN", token]]);
  const problems: string[] = [];
  const [set] = pageCalls(text).calls;
  for (const tab of ["curl", "JavaScript"]) {
    const [call, output] = set.tabs[tab] ?? [];
    if (!call || output?.title !== "Output") { problems.push(`${PAGE}:${set.line}: the ${tab} tab holds no call followed by its Output`); continue; }
    const code = filledIn(call.code, names, call.line);
    const printed = tab === "curl" ? await runShell(code, {}) : await runScript(code, {});
    problems.push(...printedProblems(output, printed, names, `${PAGE}:${output.line} (${tab})`));
  }
  const helper = filledIn(block(text, "dezfil.mjs").code, names, 0);
  const caller = block(text, "query.mjs");
  const blocks = pageCalls(text).blocks;
  const output = blocks[blocks.indexOf(blocks.find((candidate) => candidate.line === caller.line)!) + 1];
  if (output?.title !== "Output") problems.push(`${PAGE}:${caller.line}: no Output follows query.mjs`);
  else problems.push(...printedProblems(output, await runScript(caller.code, { "dezfil.mjs": helper }), names, `${PAGE}:${output.line} (query.mjs)`));
  return problems;
}

describe("Errors", () => {
  it("gets every answer it shows from the instance, with curl, JavaScript and the helper", async () => {
    const token = await readerInstance();
    expect(await runPage(page, token)).toEqual([]);
  }, 120_000);

  it("names an answer the instance does not give, in a seeded copy of the page", async () => {
    const token = await readerInstance();
    const seeded = page.replace('"position":{"line":1,"column":15}', '"position":{"line":1,"column":16}').replace("400 sql_error: The query", "422 sql_error: The query");
    expect(seeded).not.toBe(page);
    expect(await runPage(seeded, token)).toEqual([
      expect.stringMatching(/\(curl\): the answer\.error\.position\.column: the page shows 16, the answer is 15$/),
      expect.stringMatching(/\(query\.mjs\): the page shows 422 sql_error: .*, the call printed 400 sql_error: /),
    ]);
  }, 120_000);

  it("retries only the two codes that mean wait, three attempts in all, and names an answer without an error object", async () => {
    const helper = block(page, "dezfil.mjs").code;
    const calls: string[] = [];
    let answers: Response[] = [];
    vi.stubGlobal("fetch", async (input: string) => { calls.push(input); return answers.shift()!; });
    const busy = () => new Response(JSON.stringify({ error: { code: "operation_queue_full", message: "Busy." } }), { status: 503, headers: { "retry-after": "1" } });
    const run = async (script: string) => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const printed = runScript(script, { "dezfil.mjs": helper });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      return printed;
    };
    const script = 'import { request } from "./dezfil.mjs";\ntry { console.log(JSON.stringify(await request("GET", "/api/maps"))); } catch (failure) { console.log(failure.message, failure.status, failure.error.code); }';

    answers = [busy(), busy(), new Response("[]", { status: 200 })];
    expect(await run(script)).toBe("[]\n");
    expect(calls).toHaveLength(3);

    calls.length = 0;
    answers = [busy(), busy(), busy(), busy()];
    expect(await run(script)).toBe("503 operation_queue_full: Busy. 503 operation_queue_full\n");
    expect(calls).toHaveLength(3);

    calls.length = 0;
    answers = [new Response(JSON.stringify({ error: { code: "stale_revision", message: "This item has changed." } }), { status: 409 })];
    expect(await run(script)).toBe("409 stale_revision: This item has changed. 409 stale_revision\n");
    expect(calls).toHaveLength(1);

    calls.length = 0;
    answers = [new Response("<!DOCTYPE html>", { status: 404, statusText: "Not Found" })];
    expect(await run(script)).toBe("404 http_404: Not Found 404 http_404\n");
  });

  it("lists real codes and fields, every code the other API pages name, and each field's values", () => {
    const sections = ["What to do about common codes", "What an error answer holds"];
    const rows = tableRows(page, sections[0]);
    const listed = rows.map((row) => codeIn(row[0]));
    expect(listed.filter((code) => !(code in catalogue))).toEqual([]);
    expect(listed.length).toBe(new Set(listed).size);
    for (const file of NAMING_PAGES) {
      const named = [...readFileSync(file, "utf8").matchAll(/`(?:\d{3} )?([a-z_]+)`/g)].map((found) => found[1]).filter((code) => code in catalogue);
      expect(named.filter((code) => !listed.includes(code)), file).toEqual([]);
    }
    // The fields beside code and message are the error schema's, each once.
    const error = document.components.schemas.Error.properties.error as { properties: Record<string, { enum?: string[] }> };
    const fields = tableRows(page, sections[1]).map((row) => codeIn(row[0])).filter((field) => !["code", "message"].includes(field));
    expect(fields.sort()).toEqual(Object.keys(error.properties).filter((field) => !["code", "message"].includes(field)).sort());
    const rule = tableRows(page, sections[1]).find((row) => codeIn(row[0]) === "rule")!;
    expect([...rule[2].matchAll(/`([^`]+)`/g)].map((found) => found[1])).toEqual(error.properties.rule.enum);
    for (const row of tableRows(page, sections[1]).slice(2)) {
      for (const code of [...row[1].matchAll(/`([a-z_]+)`/g)].map((found) => found[1])) expect(catalogue, `${row[0]} comes with ${code}`).toHaveProperty(code);
    }
    // A table naming a code the catalogue lacks is named.
    expect([...listed, "no_such_code"].filter((code) => !(code in catalogue))).toEqual(["no_such_code"]);
  });

  it("gives the status the instance answers, for the codes made to happen here", async () => {
    const token = await readerInstance();
    const status = new Map(tableRows(page, "What to do about common codes").map((row) => [codeIn(row[0]), Number(/^\d{3}/.exec(row[1])?.[0])]));
    const call = async (method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const response = await fetch(ADDRESS + path, {
        method, headers: { authorization: `Bearer ${init.token ?? token}`, "content-type": "application/json", ...init.headers },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: response.status, code: (await response.json().catch(() => null))?.error?.code as string | undefined, allow: response.headers.get("allow") };
    };
    const map = await fetch(`${ADDRESS}/api/maps`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Field notes" }) }).then((response) => response.json());
    const renamed = await call("PATCH", `/api/maps/${map.id}`, { body: { name: "Survey map" }, headers: { "x-edit-revision": map.editRevision } });
    expect(renamed.status).toBe(200);
    const happened = {
      authentication_required: await call("GET", "/api/maps", { token: "dz_token_not-a-token" }),
      not_found: await call("GET", "/api/maps/no-such-map"),
      method_not_allowed: await call("DELETE", "/api/query"),
      invalid_request: await call("PATCH", `/api/maps/${map.id}`, { body: { name: "Again" } }),
      stale_revision: await call("PATCH", `/api/maps/${map.id}`, { body: { name: "Again" }, headers: { "x-edit-revision": map.editRevision } }),
      sql_rejected: await call("POST", "/api/query", { body: { sql: "DELETE FROM no_such_dataset" } }),
      sql_error: await call("POST", "/api/query", { body: { sql: "SELECT * FROM no_such_dataset" } }),
    };
    for (const [code, answer] of Object.entries(happened)) expect([answer.code, answer.status], code).toEqual([code, status.get(code)]);
    expect(happened.method_not_allowed.allow, "the Allow header names the methods").toMatch(/POST/);
  }, 120_000);
});
