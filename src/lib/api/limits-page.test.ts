import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { settingRemedy } from "@/lib/settings/remedy";
import { filledIn, ownInstance, pageCalls, printedProblems, runScript, runShell, type OwnInstance, type PageBlock, type PageCall } from "@/lib/test-support/page-calls";

// Limits shows its calls as curl and JavaScript tabs, each followed by what
// it prints, in the tab or after the tab set. They run here as a reader runs
// them, every curl tab on one new instance and every JavaScript tab on a
// second, the reader being the instance's first account and so its admin.
// What the page says around the calls (a locked key, the configuration read,
// the four bounded reads and their tools, each body's refusal code) must be
// what the instance and its description hold.

const PAGE = "docs/api/limits.md";
const ADDRESS = "http://localhost:3000";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };

const page = readFileSync(PAGE, "utf8");
const document = buildOpenApiDocument();

let instance: OwnInstance | undefined;
afterEach(async () => { await instance?.close(); instance = undefined; });

/** A new instance whose first account, its admin, is the reader's, with a
 * token. */
async function readerInstance(): Promise<string> {
  instance = await ownInstance(ADDRESS, "3452");
  const json = { "content-type": "application/json", origin: ADDRESS };
  const setup = await fetch(`${ADDRESS}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify(READER) });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.getSetCookie()[0].split(";")[0];
  const made = await fetch(`${ADDRESS}/api/account/tokens`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Script" }) });
  return (await made.json()).secret as string;
}

/** A tab's call and what it prints: the tab's Output, or the set's. */
function tabCall(set: PageCall, tab: string): { code?: PageBlock; output?: PageBlock } {
  const blocks = set.tabs[tab] ?? [];
  return { code: blocks.find((block) => block.title !== "Output"), output: blocks.find((block) => block.title === "Output") ?? set.output };
}

/** Every call of a copy of the page in one tab, in order. */
async function runTab(text: string, tab: "curl" | "JavaScript", token: string): Promise<string[]> {
  const names = new Map<string, unknown>([["YOUR_TOKEN", token], ["YOUR_ADMIN_TOKEN", token]]);
  const problems: string[] = [];
  for (const set of pageCalls(text).calls) {
    const { code, output } = tabCall(set, tab);
    const where = `${PAGE}:${set.line} (${tab})`;
    if (!code || !output) { problems.push(`${where}: the tab holds no call followed by its Output`); continue; }
    try {
      const filled = filledIn(code.code, names, code.line);
      const printed = tab === "curl" ? await runShell(filled, {}) : await runScript(filled, {});
      problems.push(...printedProblems(output, printed, names, `${PAGE}:${output.line} (${tab})`));
    } catch (error) { problems.push(`${where}: ${(error as Error).message}`); }
  }
  return problems;
}

describe("Limits", () => {
  it("shows four calls as curl and JavaScript tabs, each with what it prints", () => {
    const { calls } = pageCalls(page);
    expect(calls.map((set) => Object.keys(set.tabs))).toEqual(Array(4).fill(["curl", "JavaScript"]));
    for (const set of calls) for (const tab of ["curl", "JavaScript"]) expect(tabCall(set, tab).output, `${PAGE}:${set.line} ${tab}`).toBeDefined();
  });

  it("gets every answer it shows from a new instance, run with curl", async () => {
    const token = await readerInstance();
    expect(await runTab(page, "curl", token)).toEqual([]);
  }, 120_000);

  it("gets every answer it shows from a new instance, run with JavaScript", async () => {
    const token = await readerInstance();
    expect(await runTab(page, "JavaScript", token)).toEqual([]);
  }, 120_000);

  it("names an answer the instance does not give, in a seeded copy of the page", async () => {
    const token = await readerInstance();
    const seeded = page.replace('{"rowCount":1001,"shown":1000,"previewTruncated":true}', '{"rowCount":1001,"shown":1001,"previewTruncated":true}').replace("\n422\n```", "\n413\n```");
    expect(seeded).not.toBe(page);
    expect(await runTab(seeded, "curl", token)).toEqual([
      expect.stringMatching(/\(curl\): the answer\.shown: the page shows 1001, the answer is 1000$/),
      expect.stringMatching(/\(curl\): the page shows 413, the call printed 422$/),
    ]);
  }, 120_000);

  it("refuses a key a variable sets, reads the limits two ways, and quotes the message a setting's refusal ends with", async () => {
    const token = await readerInstance();
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    vi.stubEnv("DEZFIL_PREVIEW_ROWS", "500");
    const locked = await fetch(`${ADDRESS}/api/instance/settings`, { method: "PATCH", headers: auth, body: JSON.stringify({ previewRows: 2000 }) });
    expect([locked.status, (await locked.json()).error.code], "a key a variable sets").toEqual([409, "setting_locked"]);
    const read = await (await fetch(`${ADDRESS}/api/instance/settings`, { headers: auth })).json();
    expect(read.settings.previewRows, "nothing changes").toMatchObject({ value: 500, source: "environment", locked: true });
    const config = await (await fetch(`${ADDRESS}/api/config`, { headers: auth })).json();
    expect(config).toMatchObject({ previewRows: 500, renderCapFeatures: expect.any(Number) });
    const quoted = /say in their `message` which setting changes it, such as `([^`]+)`/.exec(page)?.[1];
    expect(quoted).toBe(settingRemedy("queryTimeoutS"));
  }, 120_000);

  it("names each bounded read by the operation and the tool the description gives it", () => {
    const section = page.split("\n## SQL results\n")[1].split("\n## ")[0];
    const rows = section.split("\n").filter((line) => line.startsWith("| ")).map((line) => line.slice(2, -2).split(" | ")).filter((cells) => /^`[A-Z]+ \//.test(cells[1] ?? ""));
    expect(rows).toHaveLength(4);
    for (const [, http, tool] of rows) {
      const [method, path] = /^`([A-Z]+) ([^`]+)`$/.exec(http)!.slice(1);
      const operation = (document.paths as Record<string, Record<string, { "x-tool"?: string | false; description: string }>>)[path][method.toLowerCase()];
      expect(`\`${operation["x-tool"]}\``, http).toBe(tool);
      for (const bound of ["33,554,432", "2,097,152", "query_result_too_large"]) expect(operation.description, http).toContain(bound);
    }
  });

  it("gives the code each JSON body over its limit is refused with, as the description states it", () => {
    const codes = new Map<string, string[]>();
    for (const [path, item] of Object.entries(document.paths as Record<string, Record<string, { requestBody?: Record<string, unknown> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        const body = operation?.requestBody;
        if (body?.["x-byte-limit"] === undefined) continue;
        expect(typeof body["x-byte-error"], `${method} ${path} states its refusal code`).toBe("string");
        codes.set(String(body["x-byte-error"]), [...codes.get(String(body["x-byte-error"])) ?? [], `${method.toUpperCase()} ${path}`]);
      }
    }
    const cell = page.split("\n").find((line) => line.startsWith("| A JSON body |"))!;
    expect([...cell.split(" | ")[2].matchAll(/`([a-z_]+)`/g)].map((found) => found[1]).sort(), cell).toEqual([...codes.keys()].sort());
    expect(codes.get("assistant_submission_too_large")).toEqual(["POST /api/assistant/messages"]);
  });
});
