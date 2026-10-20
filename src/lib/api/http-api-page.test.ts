import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { laneSettled } from "@/lib/operations/lane";
import { answerProblems, filledIn, ownInstance, pageCalls, runShell, shownAnswer, type OwnInstance, type PageBlock } from "@/lib/test-support/page-calls";

// How the API works shows its calls as terminal blocks, each followed by
// the answer it gives. They run here in the page's order, as a reader runs
// them, against an instance of their own on which the reader has a token
// and the two datasets the paging example names; each answer must be the
// one the page shows, and what the page quotes from an answer must be what
// the instance answers. The JavaScript revision example runs in its own
// test, beside the MCP guide's.

const PAGE = "docs/api/http-api.md";
const ADDRESS = "http://localhost:3000";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };
const page = readFileSync(PAGE, "utf8");

/** Each terminal block that a block titled Output follows, with it. */
function terminalCalls(text: string): { call: PageBlock; output: PageBlock }[] {
  const { blocks } = pageCalls(text);
  return blocks.flatMap((block, index) => {
    const next = blocks[index + 1];
    return block.lang === "sh" && block.title === "Terminal" && next?.title === "Output" && !block.code.startsWith("node ") ? [{ call: block, output: next }] : [];
  });
}

/** Where one printed answer differs from the one the page shows. A text
 * answer is held line by line: a line of JSON as JSON, any other as text. */
function outputProblems(output: PageBlock, text: string, names: Map<string, unknown>): string[] {
  const where = `${PAGE}:${output.line}`;
  const shown = output.lang === "json" ? [output.code] : output.code.split("\n");
  const printed = output.lang === "json" ? [text.trim()] : text.replace(/\n$/, "").split("\n");
  if (shown.length !== printed.length) return [`${where}: the page shows ${shown.length} lines, the call printed ${printed.length}: ${text}`];
  return shown.flatMap((line, index) => {
    if (!/^[{[]/.test(line)) return line === printed[index] ? [] : [`${where}: the page shows ${line}, the call printed ${printed[index]}`];
    let actual: unknown;
    try { actual = JSON.parse(printed[index]); } catch { return [`${where}: the call printed no JSON: ${printed[index].slice(0, 200)}`]; }
    return answerProblems(shownAnswer(line), actual, names, new Set()).map((problem) => `${where}: ${problem}`);
  });
}

let instance: OwnInstance | undefined;
afterEach(async () => { await instance?.close(); instance = undefined; });

/** A new instance with the reader's account, a token and the datasets
 * world_cities and big_cities. */
async function readerInstance(): Promise<{ token: string }> {
  instance = await ownInstance(ADDRESS, "3452");
  const json = { "content-type": "application/json", origin: ADDRESS };
  const setup = await fetch(`${ADDRESS}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify(READER) });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.getSetCookie()[0].split(";")[0];
  const made = await fetch(`${ADDRESS}/api/account/tokens`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Script" }) });
  const token = (await made.json()).secret as string;
  const cities = pageCalls(readFileSync("docs/start/first-map.md", "utf8")).blocks.find((block) => block.title === "world-cities.csv")!;
  const form = new FormData();
  form.append("file", new Blob([`${cities.code}\n`]), "world-cities.csv");
  expect((await fetch(`${ADDRESS}/api/tables`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form })).status).toBe(201);
  const saved = await fetch(`${ADDRESS}/api/operations/run`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "sql_step", parameters: { sql: "SELECT name, country, population, geometry FROM world_cities WHERE population > 10000000", name: "big_cities" } }),
  });
  expect(saved.status).toBe(202);
  await laneSettled();
  return { token };
}

/** Every terminal call of a copy of the page, in order, against the
 * instance; the problems, and what each call printed. */
async function runPage(text: string, token: string): Promise<{ problems: string[]; names: Map<string, unknown> }> {
  const names = new Map<string, unknown>([["YOUR_TOKEN", token], ["YOUR_NAME", READER.name], ["YOUR_EMAIL", READER.email]]);
  const problems: string[] = [];
  for (const { call, output } of terminalCalls(text)) {
    try { problems.push(...outputProblems(output, await runShell(filledIn(call.code, names, call.line), {}), names)); }
    catch (error) { problems.push(`${PAGE}:${call.line}: ${(error as Error).message}`); }
  }
  return { problems, names };
}

describe("How the API works", () => {
  it("shows seven calls in a terminal, each with its answer", () => {
    expect(terminalCalls(page).map(({ call }) => call.code.split("\n")[0].replace(/<[A-Z_]+>/g, "<>"))).toEqual([
      'curl -s http://localhost:3000/api/account -H "Authorization: Bearer <>"',
      "curl -s http://localhost:3000/api/account/tokens \\",
      "curl -s http://localhost:3000/api/maps \\",
      "curl -s -X PATCH http://localhost:3000/api/maps/<> \\",
      "curl -s -X PATCH http://localhost:3000/api/maps/<> \\",
      'curl -s "http://localhost:3000/api/catalogue/tables?limit=1" -H "Authorization: Bearer <>"',
      'curl -s -w "\\n%{http_code}\\n" http://localhost:3000/api/maps/no-such-map -H "Authorization: Bearer <>"',
    ]);
  });

  it("gets every answer it shows from the instance, and the sentences it quotes", async () => {
    const { token } = await readerInstance();
    const { problems, names } = await runPage(page, token);
    expect(problems).toEqual([]);

    // The stale revision's sentence, from a change sent with the revision
    // the rename replaced.
    const stale = /`409 stale_revision` means someone changed the item after you read it: "([^"]+)"/.exec(page)?.[1];
    const resent = await fetch(`${ADDRESS}/api/maps/${names.get("MAP_ID")}`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-edit-revision": String(names.get("MAP_REVISION")) }, body: JSON.stringify({ name: "Again" }),
    });
    expect([resent.status, (await resent.json()).error]).toEqual([409, { code: "stale_revision", message: stale }]);

    // A connection string with a protection Dezfil can't give is refused
    // with the sentence the page quotes, before any database is reached.
    const refusal = /The answer is `400 invalid_request`: "([^"]+)"/.exec(page)?.[1];
    expect(refusal).toContain("channel_binding");
    const refused = await fetch(`${ADDRESS}/api/connections/postgis`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Survey", url: "postgres://ana:secret@db.example.com:5432/gis?channel_binding=require", password: "secret" }),
    });
    expect([refused.status, (await refused.json()).error]).toEqual([400, { code: "invalid_request", message: refusal }]);
  }, 120_000);

  it("names an answer the instance does not give, in a seeded copy of the page", async () => {
    const { token } = await readerInstance();
    const seeded = page.replace('"total":2,"nextAfter":"big_cities"', '"total":3,"nextAfter":"big_cities"').replace("\n404\n", "\n403\n");
    expect(seeded).not.toBe(page);
    const { problems } = await runPage(seeded, token);
    expect(problems).toEqual([
      expect.stringMatching(/the answer\.total: the page shows 3, the answer is 2$/),
      expect.stringMatching(/the page shows 403, the call printed 404$/),
    ]);
  }, 120_000);
});
