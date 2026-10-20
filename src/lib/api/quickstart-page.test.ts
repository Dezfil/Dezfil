import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { answerProblems, filledIn, ownInstance, pageCalls, runScript, runShell, shownAnswer, type OwnInstance, type PageCall } from "@/lib/test-support/page-calls";

// The API quickstart's calls, run as a reader runs them, against an
// instance of their own: every curl tab, and on a second new instance
// every JavaScript tab, in the page's order. Each answer must be the one
// the page shows after the call, and what the page says the instance
// answers in Troubleshooting must be what it answers.

const PAGE = "docs/api/quickstart.md";
const ADDRESS = "http://localhost:3000";
const PORT = "3452";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };
/** The fields the page says differ from run to run. */
const VARIES = new Set(["runtimeMs"]);

const page = readFileSync(PAGE, "utf8");

/** The cities the quickstart uploads: the file Your first map has the
 * reader save, read from that page. */
function citiesFile(): Record<string, string> {
  const first = pageCalls(readFileSync("docs/start/first-map.md", "utf8")).blocks.find((block) => block.title === "world-cities.csv");
  expect(first, "Your first map shows world-cities.csv").toBeDefined();
  return { "world-cities.csv": `${first!.code}\n` };
}

/** The values a reader knows before the first call: their own account. */
const known = () => new Map<string, unknown>([["YOUR_EMAIL", READER.email], ["YOUR_PASSWORD", READER.password], ["YOUR_NAME", READER.name]]);

let instance: OwnInstance | undefined;
afterEach(async () => { await instance?.close(); instance = undefined; });

/** A new instance whose first account is the reader's, made as Install
 * makes it. */
async function newInstance(): Promise<OwnInstance> {
  instance = await ownInstance(ADDRESS, PORT);
  const setup = await fetch(`${ADDRESS}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json", origin: ADDRESS }, body: JSON.stringify(READER),
  });
  expect(setup.status, "the first account is made").toBe(200);
  return instance;
}

interface Run { problems: string[]; printed: string[]; names: Map<string, unknown> }

/** Every call of the page in one tab, in order, each answer held against
 * the one the page shows. */
async function runTab(tab: "curl" | "JavaScript", calls: PageCall[]): Promise<Run> {
  const names = known(), problems: string[] = [], printed: string[] = [];
  const files = citiesFile();
  for (const call of calls) {
    const block = call.tabs[tab];
    const where = `${PAGE}:${call.line} (${tab})`;
    if (!block) { problems.push(`${where}: the call has no ${tab} tab`); continue; }
    if (!call.output) { problems.push(`${where}: no Output block follows the call`); continue; }
    let text: string;
    try {
      const code = filledIn(block.code, names, block.line);
      text = tab === "curl" ? await runShell(code, files) : await runScript(code, files);
    } catch (error) { problems.push(`${where}: ${(error as Error).message}`); printed.push(""); continue; }
    printed.push(text);
    problems.push(...outputProblems(call, text, names, tab));
  }
  return { problems, printed, names };
}

/** Where one printed answer differs from the Output block the page shows. */
function outputProblems(call: PageCall, text: string, names: Map<string, unknown>, tab: string): string[] {
  const where = `${PAGE}:${call.output!.line} (${tab})`;
  let actual: unknown;
  try { actual = JSON.parse(text); } catch { return [`${where}: the call printed no JSON: ${text.slice(0, 200)}`]; }
  const shown = shownAnswer(call.output!.code) as { error?: unknown };
  const refused = (actual as { error?: { code?: string; message?: string } } | null)?.error;
  if (refused && !(shown && typeof shown === "object" && "error" in shown)) return [`${where}: the call was refused with ${refused.code}: ${refused.message}`];
  return answerProblems(shown, actual, names, VARIES).map((problem) => `${where}: ${problem}`);
}

/** The same printed answers held against another copy of the page. */
function againstPage(text: string, printed: string[]): string[] {
  const names = known();
  return pageCalls(text).calls.flatMap((call, index) => outputProblems(call, printed[index], names, "curl"));
}

/** A call to the instance with the reader's token. */
async function call(method: string, path: string, token: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(ADDRESS + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/** Each Troubleshooting entry's status and code, and the sentence the page
 * quotes from the answer, if it quotes one. */
function troubleshooting(): { heading: string; status: number; code: string; quote?: string }[] {
  const section = page.split("\n## Troubleshooting\n")[1].split("\n## ")[0];
  return section.split("\n### ").slice(1).map((entry) => {
    const [heading, ...body] = entry.split("\n");
    const answer = /answers (\d{3}) `([a-z_]+)`/.exec(heading);
    expect(answer, heading).not.toBeNull();
    return { heading, status: Number(answer![1]), code: answer![2], quote: /The answer says "([^"]+)"/.exec(body.join(" "))?.[1] };
  });
}

describe("the API quickstart", () => {
  const { calls } = pageCalls(page);

  it("shows its calls as curl and JavaScript tabs, each followed by its answer", () => {
    expect(calls.map((found) => Object.keys(found.tabs))).toEqual(Array(7).fill(["curl", "JavaScript"]));
    expect(calls.every((found) => found.output)).toBe(true);
  });

  it("gets every answer it shows from a new instance, run with curl", async () => {
    await newInstance();
    const run = await runTab("curl", calls);
    expect(run.problems).toEqual([]);
    const token = String(run.names.get("YOUR_TOKEN"));
    const map = String(run.names.get("MAP_ID"));

    // What the page says of its answers beyond the Output blocks.
    expect(token).toMatch(/^dz_token_/);
    const link = `/api/published/${run.names.get("PUBLISH_TOKEN")}`;
    const published = await fetch(ADDRESS + link);
    expect(published.status, "anyone with the link opens the map").toBe(200);
    const view = await published.json() as { theme: string; layers: { name: string; render: { geojson?: { features: unknown[] } } }[] };
    expect(view.theme, "the published view opens in the dark theme").toBe("dark");
    expect(view.layers.map((layer) => [layer.name, layer.render.geojson?.features.length]), "the map shows its 15 cities").toEqual([["Big cities", 15]]);
    const form = new FormData();
    form.append("file", new Blob([citiesFile()["world-cities.csv"]]), "world-cities.csv");
    const again = await fetch(`${ADDRESS}/api/tables`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    expect((await again.json()).name, "the same file again makes a copy").toBe("world_cities_2");
    const stopped = await call("DELETE", `/api/maps/${map}/publish`, token, { headers: { "x-edit-revision": String(run.names.get("PUBLISH_REVISION")) } });
    expect(stopped.status, "DELETE with the newest editRevision stops sharing").toBe(200);
    expect((await fetch(ADDRESS + link)).status, "the link stops working at once").toBe(404);

    // Troubleshooting: each answer, made happen, is the one the page names.
    const happen: Record<string, () => Promise<{ status: number; json: { error: { code: string; message: string; rule?: string } } }>> = {
      authentication_required: () => call("GET", "/api/maps", "dz_token_not-a-token"),
      forbidden: async () => {
        const response = await fetch(`${ADDRESS}/api/auth/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: READER.email, password: READER.password }) });
        return { status: response.status, json: await response.json() };
      },
      invalid_request: () => call("POST", `/api/maps/${map}/layers`, token, { body: { name: "Again", sql: "SELECT geometry FROM world_cities" } }),
      stale_revision: () => call("POST", `/api/maps/${map}/layers`, token, { body: { name: "Again", sql: "SELECT geometry FROM world_cities" }, headers: { "x-edit-revision": String(run.names.get("MAP_REVISION")) } }),
      rule_refused: async () => {
        expect((await call("PATCH", "/api/instance/settings", token, { body: { "publishing.publish": "none" } })).status).toBe(200);
        const current = await call("GET", `/api/maps/${map}`, token);
        const refused = await call("POST", `/api/maps/${map}/publish`, token, { headers: { "x-edit-revision": current.json.editRevision } });
        expect(refused.json.error.rule, "the answer's rule field names the rule").toBe("publishing.publish");
        return refused;
      },
    };
    const entries = troubleshooting();
    expect(entries.map((entry) => entry.code).sort()).toEqual(Object.keys(happen).sort());
    for (const entry of entries) {
      const answer = await happen[entry.code]();
      expect([answer.status, answer.json.error.code], entry.heading).toEqual([entry.status, entry.code]);
      if (entry.quote) expect(answer.json.error.message, entry.heading).toBe(entry.quote);
    }
  }, 120_000);

  it("gets every answer it shows from a new instance, run with JavaScript", async () => {
    await newInstance();
    const run = await runTab("JavaScript", calls);
    expect(run.problems).toEqual([]);
  }, 120_000);

  it("names an answer the instance does not give: a seeded copy of the page fails at the calls it changed", async () => {
    await newInstance();
    const run = await runTab("curl", calls);
    expect(run.problems).toEqual([]);
    const seeded = page
      .replace('"rowCount": 48,', '"rowCount": 47,')
      .replace('{ "name": "Tokyo", "country": "Japan", "population": "35676000" }', '{ "name": "Osaka", "country": "Japan", "population": "35676000" }')
      .replace('"published": false,', '"published": true,');
    expect(seeded).not.toBe(page);
    const problems = againstPage(seeded, run.printed);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/the answer\.rowCount: the page shows 47, the answer is 48/);
    expect(problems.join("\n")).toMatch(/the answer\.preview\[0\]\.name: the page shows "Osaka", the answer is "Tokyo"/);
    expect(problems.join("\n")).toMatch(/the answer\.published: the page shows true, the answer is false/);
    expect(againstPage(page, run.printed)).toEqual([]);
  }, 120_000);
});

describe("an answer as a page shows it", () => {
  it("reads ... as fields left out, and holds the fields shown, their order and the names they give", () => {
    const names = new Map<string, unknown>();
    const shown = shownAnswer('{\n  "id": "<MAP_ID>",\n  ...\n  "name": "World cities",\n  "style": { ... },\n  "at": "2026-10-20T09:00:00.000Z"\n}');
    expect(answerProblems(shown, { id: "a1", extra: 1, name: "World cities", style: { r: 1 }, at: "2027-01-01T00:00:00Z" }, names, new Set())).toEqual([]);
    expect(names.get("MAP_ID")).toBe("a1");
    expect(answerProblems(shownAnswer('{"id":"<MAP_ID>",...}'), { id: "b2" }, names, new Set())).toEqual(['the answer.id: the page shows <MAP_ID>, which stood for "a1"; the answer is "b2"']);
    expect(answerProblems(shownAnswer('{"name":"x","id":"y"}'), { id: "y", name: "x" }, new Map(), new Set())).toEqual(["the answer: the page shows the fields as name, id; the answer has them as id, name"]);
    expect(answerProblems(shownAnswer('{"id":"y"}'), { id: "y", name: "x" }, new Map(), new Set())).toEqual(["the answer: the answer also has name, which the page neither shows nor cuts with ..."]);
    expect(answerProblems(shownAnswer('{"runtimeMs": 4}'), { runtimeMs: 11 }, new Map(), new Set(["runtimeMs"]))).toEqual([]);
    expect(answerProblems(shownAnswer('{"runtimeMs": 4}'), { runtimeMs: 11 }, new Map(), new Set())).toEqual(["the answer.runtimeMs: the page shows 4, the answer is 11"]);
  });
});
