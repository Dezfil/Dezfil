import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { clientGuide } from "@/lib/mcp/client-guide";
import { ruleRefusal } from "@/lib/settings/instance-rules";
import { ownInstance, pageCalls, printedProblems, runShell, type OwnInstance, type PageBlock } from "@/lib/test-support/page-calls";

// Connect an AI agent shows each client's configuration, the tools an agent
// gets, and a call that tests the token the reader set once in
// DEZFIL_API_TOKEN. The configurations must be what the MCP server card
// copies for the same address, every tool the page names must be one the
// server offers, and the token test must answer as the page shows, run as a
// reader runs it against an instance of their own. The edit example runs
// beside How the API works', in the revision examples' test.

const PAGE = "docs/api/mcp.md";
const ADDRESS = "http://localhost:3000";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };
const page = readFileSync(PAGE, "utf8");
const { blocks } = pageCalls(page);

/** The code blocks of one tab, by its label, across the page. */
function tabBlocks(label: string): PageBlock[] {
  const lines = page.split("\n");
  const found: PageBlock[] = [];
  let open = false;
  lines.forEach((line, index) => {
    if (line.trim() === `:::tab[${label}]`) open = true;
    else if (line.trim() === ":::" || line.trim() === "::::") open = false;
    const block = blocks.find((candidate) => candidate.line === index + 1);
    if (open && block) found.push(block);
  });
  return found;
}

let instance: OwnInstance | undefined;
afterEach(async () => { await instance?.close(); instance = undefined; });

describe("Connect an AI agent", () => {
  it("shows each client the configuration the MCP server card copies for the same address", () => {
    const endpoint = `${ADDRESS}/api/mcp`;
    expect(tabBlocks("Claude Code").map((block) => block.code)).toEqual([clientGuide("Claude Code", endpoint).code]);
    const codex = clientGuide("Codex", endpoint);
    expect(tabBlocks("Codex").map((block) => block.code)).toEqual([codex.code, codex.alternate]);
    expect(tabBlocks("Cursor").map((block) => block.code)).toEqual([clientGuide("Cursor", endpoint).code]);
    // Every client reads the token from the one variable the reader sets.
    expect(blocks.find((block) => block.title === "~/.zshrc or ~/.bashrc")?.code).toBe('export DEZFIL_API_TOKEN="<YOUR_TOKEN>"');
    expect(clientGuide("Claude Desktop", endpoint).supported).toBe(false);
  });

  it("names only tools the server offers, and only codes the description has", () => {
    const tools = new Set(buildTools().map((tool) => tool.name));
    const codes = new Set(Object.keys(buildOpenApiDocument()["x-error-codes"] as Record<string, string>));
    // The tool inputs the page names, and the field a workflow is called by.
    const inputs = new Set(["expected_revision", "change_group"]);
    const named = [...new Set([...page.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((found) => found[1]))];
    const unknown = named.filter((name) => !tools.has(name) && !codes.has(name) && !inputs.has(name));
    expect(unknown).toEqual([]);
    const table = page.split("\n## What the agent can do\n")[1].split("\n## ")[0];
    const listed = table.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Group")).flatMap((line) => [...line.split(" | ")[2].matchAll(/`([a-z_]+)`/g)].map((found) => found[1]));
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.filter((name) => !tools.has(name))).toEqual([]);
    // An invented tool is named.
    expect([...listed, "draw_unicorn"].filter((name) => !tools.has(name))).toEqual(["draw_unicorn"]);
  });

  it("quotes the sentence a member reads while only admins may create tokens", () => {
    const quoted = /The line under it reads "([^"]+)"/.exec(page)?.[1];
    expect(quoted).toBe(ruleRefusal("tokens.create", "admins", false));
  });

  it("tests the token as the page shows, in both terminals, and quotes the answer to an empty or wrong one", async () => {
    instance = await ownInstance(ADDRESS, "3452");
    const json = { "content-type": "application/json", origin: ADDRESS };
    const setup = await fetch(`${ADDRESS}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify(READER) });
    expect(setup.status).toBe(200);
    const cookie = setup.headers.getSetCookie()[0].split(";")[0];
    const token = (await (await fetch(`${ADDRESS}/api/account/tokens`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Claude Code" }) })).json()).secret as string;

    const section = page.split("\n### Calls answer 401 `authentication_required`\n")[1].split("\n### ")[0];
    const prose = section.replace(/\s+/g, " ");
    const { calls, blocks: shown } = pageCalls(section);
    expect(calls, "the token test is not a curl and JavaScript pair").toEqual([]);
    const [unix, windows, output] = shown;
    expect([unix.title, windows.title, output.title]).toEqual(["Terminal", "PowerShell", "Output"]);
    // The Windows call is the same request, in PowerShell's words.
    expect(windows.code.replace(/^curl\.exe /, "curl ").replace("$env:DEZFIL_API_TOKEN", "$DEZFIL_API_TOKEN")).toBe(unix.code);

    const names = new Map<string, unknown>([["YOUR_NAME", READER.name], ["YOUR_EMAIL", READER.email]]);
    const printed = await runShell(unix.code, {}, { DEZFIL_API_TOKEN: token });
    expect(printedProblems(output, printed, names, `${PAGE}:${output.line}`)).toEqual([]);
    expect(JSON.parse(printed).account.isAdmin, "the first account is the instance's admin").toBe(true);
    // A seeded answer the instance does not give is named.
    const seeded = { ...output, code: output.code.replace('"<YOUR_NAME>"', '"Someone else"') };
    expect(printedProblems(seeded, printed, new Map(names), PAGE)).toEqual([`${PAGE}: the answer.account.name: the page shows "Someone else", the answer is "${READER.name}"`]);

    const refusal = /"([^"]+)" means the variable is empty, or the token is wrong or revoked/.exec(prose)?.[1];
    expect(refusal, "the page quotes the refusal").toBeDefined();
    for (const value of ["", "dz_token_not-a-token"]) {
      const answer = JSON.parse(await runShell(unix.code, {}, { DEZFIL_API_TOKEN: value }));
      expect(answer, `DEZFIL_API_TOKEN="${value}"`).toEqual({ error: { code: "authentication_required", message: refusal } });
    }
  }, 120_000);
});
