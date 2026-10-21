/// <reference types="vite/client" />
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { vi } from "vitest";
import { config, proxy } from "@/proxy";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { laneSettled } from "@/lib/operations/lane";
import { socketRequest } from "@/lib/assistant/testing/socket-request";

/**
 * Running the calls a documentation page shows, as a reader runs them, and
 * holding each answer the page shows against the one the instance gives.
 *
 * A page shows a call as a tab set with a curl tab and a JavaScript tab,
 * followed by a block titled Output. The curl tab runs as curl would run it
 * (the options the pages use, nothing else), the JavaScript tab as Node runs
 * the file its title names. Before a call runs, every `<NAME>` it holds is
 * replaced by the value an answer before it gave at the same place, as a
 * reader copies it; a name no answer gave fails the run.
 */

/** One fenced code block of a page. */
export interface PageBlock { lang: string; title: string; code: string; line: number }

/** One call a page shows: the code blocks of each tab by label, and the
 * answer after the tab set. */
export interface PageCall { line: number; tabs: Record<string, PageBlock[]>; output?: PageBlock }

const FENCE = /^(`{3,})([\w-]*)(?:\s+title="([^"]*)")?\s*$/;

/** Every code block of a page, and every tab set that holds a curl tab,
 * with the Output block that follows it. */
export function pageCalls(text: string): { blocks: PageBlock[]; calls: PageCall[] } {
  const lines = text.split("\n");
  const blocks: PageBlock[] = [];
  const calls: PageCall[] = [];
  let set: PageCall | null = null;
  let tab: string | null = null;
  let waiting: PageCall | null = null;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    const fence = FENCE.exec(line);
    if (fence) {
      const close = lines.findIndex((candidate, index) => index > at && candidate.trim() === fence[1]);
      if (close < 0) throw new Error(`line ${at + 1}: a code block is never closed`);
      const block = { lang: fence[2], title: fence[3] ?? "", code: lines.slice(at + 1, close).join("\n"), line: at + 1 };
      blocks.push(block);
      if (set && tab) (set.tabs[tab] ??= []).push(block);
      else if (waiting && block.title === "Output") {
        waiting.output = block;
        waiting = null;
      }
      at = close;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "::::tabs") { set = { line: at + 1, tabs: {} }; continue; }
    const opened = /^:::tab\[(.+)\]$/.exec(trimmed);
    if (opened && set) { tab = opened[1]; set.tabs[tab] ??= []; continue; }
    if (trimmed === ":::") { tab = null; continue; }
    if (trimmed === "::::" && set) {
      if (set.tabs.curl) { calls.push(set); waiting = set; }
      set = null;
      continue;
    }
  }
  return { blocks, calls };
}

// ---------------------------------------------------------------------------
// Answers as a page shows them

/** The key a shown answer's `...` becomes: the object it stands in holds
 * more fields than the page shows. */
const MORE = "...";
const PLACEHOLDER = /^<([A-Z][A-Z0-9_]*)>$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** An answer as the page shows it: JSON in which `...` stands for fields
 * left out. */
export function shownAnswer(text: string): unknown {
  let json = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      const end = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(at));
      if (!end) throw new Error("an answer holds an unclosed string");
      json += end[0];
      at += end[0].length - 1;
    } else if (text.startsWith("...", at)) {
      json += `"${MORE}": 0,`;
      at += text[at + 3] === "," ? 3 : 2;
    } else json += char;
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const show = (value: unknown) => JSON.stringify(value);

/**
 * Where an answer differs from the one a page shows. A `<NAME>` stands for
 * the value at its place, which every later `<NAME>` must equal; a time
 * stands for any time; a field named in `varies` for any value of its type,
 * as the page says it varies. An object the page cuts with `...` may hold
 * more fields, and one it does not cut may not; the fields shown keep the
 * answer's order.
 */
export function answerProblems(shown: unknown, actual: unknown, names: Map<string, unknown>, varies: ReadonlySet<string>, at = "the answer"): string[] {
  if (typeof shown === "string") {
    const name = PLACEHOLDER.exec(shown)?.[1];
    if (name) {
      if (actual === undefined) return [`${at}: the page shows <${name}>, the answer has nothing`];
      if (!names.has(name)) { names.set(name, actual); return []; }
      return same(names.get(name), actual) ? [] : [`${at}: the page shows <${name}>, which stood for ${show(names.get(name))}; the answer is ${show(actual)}`];
    }
    if (TIMESTAMP.test(shown)) return typeof actual === "string" && TIMESTAMP.test(actual) ? [] : [`${at}: the page shows a time, the answer is ${show(actual)}`];
  }
  if (Array.isArray(shown)) {
    if (!Array.isArray(actual)) return [`${at}: the page shows a list, the answer is ${show(actual)}`];
    if (shown.length !== actual.length) return [`${at}: the page shows ${shown.length} items, the answer has ${actual.length}`];
    return shown.flatMap((item, index) => answerProblems(item, actual[index], names, varies, `${at}[${index}]`));
  }
  if (shown && typeof shown === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return [`${at}: the page shows an object, the answer is ${show(actual)}`];
    const fields = Object.keys(shown).filter((key) => key !== MORE);
    const answer = actual as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of fields) {
      const where = `${at}.${key}`;
      if (!(key in answer)) problems.push(`${where}: the page shows it, the answer has no such field`);
      else if (varies.has(key)) { if (typeof answer[key] !== typeof (shown as Record<string, unknown>)[key]) problems.push(`${where}: the page shows a ${typeof (shown as Record<string, unknown>)[key]}, the answer is ${show(answer[key])}`); }
      else problems.push(...answerProblems((shown as Record<string, unknown>)[key], answer[key], names, varies, where));
    }
    if (!(MORE in shown)) {
      const unshown = Object.keys(answer).filter((key) => !fields.includes(key));
      if (unshown.length) problems.push(`${at}: the answer also has ${unshown.join(", ")}, which the page neither shows nor cuts with ...`);
    }
    const order = Object.keys(answer).filter((key) => fields.includes(key));
    if (order.length === fields.length && !same(order, fields)) problems.push(`${at}: the page shows the fields as ${fields.join(", ")}; the answer has them as ${order.join(", ")}`);
    return problems;
  }
  return same(shown, actual) ? [] : [`${at}: the page shows ${show(shown)}, the answer is ${show(actual)}`];
}

/** Where what a call printed differs from the Output block the page shows
 * after it, each problem led by `where`. A json block is one answer, however
 * many lines the page spreads it over; a text block is held line by line, a
 * line of JSON as an answer and any other line as text. */
export function printedProblems(output: PageBlock, text: string, names: Map<string, unknown>, where: string, varies: ReadonlySet<string> = new Set()): string[] {
  const shown = output.lang === "json" ? [output.code] : output.code.split("\n");
  const printed = output.lang === "json" ? [text.trim()] : text.replace(/\n$/, "").split("\n");
  if (shown.length !== printed.length) return [`${where}: the page shows ${shown.length} lines, the call printed ${printed.length}: ${text}`];
  return shown.flatMap((line, index) => {
    if (!/^[{[]/.test(line)) return line === printed[index] ? [] : [`${where}: the page shows ${line}, the call printed ${printed[index]}`];
    let actual: unknown;
    try { actual = JSON.parse(printed[index]); } catch { return [`${where}: the call printed no JSON: ${printed[index].slice(0, 200)}`]; }
    return answerProblems(shownAnswer(line), actual, names, varies).map((problem) => `${where}: ${problem}`);
  });
}

/** A call's code with every `<NAME>` replaced as a reader replaces it. */
export function filledIn(code: string, names: Map<string, unknown>, line: number): string {
  return code.replace(/<([A-Z][A-Z0-9_]*)>/g, (_whole, name: string) => {
    if (!names.has(name)) throw new Error(`line ${line}: the call names <${name}>, which no answer before it gave`);
    return String(names.get(name));
  });
}

// ---------------------------------------------------------------------------
// curl, as the pages use it

/** A shell block's commands, as words: a backslash at a line's end joins
 * the next line, single quotes keep what they hold, double quotes and bare
 * words expand `$NAME`, and a bare `|` is a word of its own, the pipe
 * between two commands. Any other shell syntax fails. */
export function shellCommands(code: string, environment: Record<string, string>): string[][] {
  const expand = (text: string, at: number): [string, number] => {
    const variable = /^\$\{?([A-Za-z_]\w*)\}?/.exec(text.slice(at));
    if (!variable) throw new Error(`unsupported shell syntax at ${text.slice(at)}`);
    if (!(variable[1] in environment)) throw new Error(`$${variable[1]} is not set`);
    return [environment[variable[1]], variable[0].length];
  };
  const commands: string[][] = [];
  for (const line of code.replace(/\\\n/g, " ").split("\n")) {
    if (!line.trim()) continue;
    const words: string[] = [];
    let word = "", started = false;
    for (let at = 0; at < line.length;) {
      const char = line[at];
      if (/\s/.test(char)) { if (started) words.push(word); word = ""; started = false; at++; continue; }
      started = true;
      if (char === "'") {
        const end = line.indexOf("'", at + 1);
        if (end < 0) throw new Error("an unclosed single quote");
        word += line.slice(at + 1, end); at = end + 1;
      } else if (char === '"') {
        at++;
        while (line[at] !== '"') {
          if (at >= line.length) throw new Error("an unclosed double quote");
          if (line[at] === "\\" && '"\\$`'.includes(line[at + 1])) { word += line[at + 1]; at += 2; }
          else if (line[at] === "$") { const [value, length] = expand(line, at); word += value; at += length; }
          else word += line[at++];
        }
        at++;
      } else if (char === "$") { const [value, length] = expand(line, at); word += value; at += length; }
      else if (char === "|" && word === "" && /^\|(?:\s|$)/.test(line.slice(at))) { words.push(PIPE); started = false; at++; }
      else if ("|&;<>()`\\#".includes(char)) throw new Error(`unsupported shell syntax ${char} in: ${line.trim()}`);
      else { word += char; at++; }
    }
    if (started) words.push(word);
    commands.push(words);
  }
  return commands;
}

/** The word a bare `|` becomes: no quoted word can be it. */
const PIPE = "\0|";

/** What one shell block prints, run as a shell would: `curl`, `export` and
 * `rm` of a file the block wrote, which is all the pages use, and a curl
 * call piped into `jq`, which runs the real jq on what curl printed. The
 * environment holds the variables the reader set before the block. */
export async function runShell(code: string, files: Record<string, string>, set: Record<string, string> = {}): Promise<string> {
  const environment: Record<string, string> = { ...set };
  const cookies = new Map<string, string>();
  let printed = "";
  for (const words of shellCommands(code, environment)) {
    const stages: string[][] = [[]];
    for (const word of words) {
      if (word === PIPE) stages.push([]);
      else stages.at(-1)!.push(word);
    }
    const [[command, ...args], ...piped] = stages;
    if (piped.length) {
      if (command !== "curl" || piped.some(([next]) => next !== "jq")) throw new Error(`the runner pipes only curl into jq: ${words.join(" ")}`);
      let text = await curl(args, cookies, files);
      for (const [, ...filter] of piped) text = jq(filter, text);
      printed += text;
      continue;
    }
    if (command === "export") {
      for (const assignment of args) {
        const at = assignment.indexOf("=");
        environment[assignment.slice(0, at)] = assignment.slice(at + 1);
      }
    } else if (command === "rm") {
      for (const file of args) if (!cookies.delete(file)) throw new Error(`rm ${file}: the block wrote no such file`);
    } else if (command === "curl") printed += await curl(args, cookies, files);
    else throw new Error(`the runner does not know the command ${command}`);
  }
  return printed;
}

/** What jq prints for an input, run as the real program. */
function jq(args: string[], input: string): string {
  try { return execFileSync("jq", args, { input, encoding: "utf8" }); }
  catch (error) {
    const failed = error as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(failed.code === "ENOENT" ? "the page pipes curl into jq, which is not installed here" : `jq ${args.join(" ")}: ${failed.stderr ?? failed.message}`);
  }
}

/** One curl call: what it sends, and what it prints. */
async function curl(args: string[], cookies: Map<string, string>, files: Record<string, string>): Promise<string> {
  const headers = new Headers({ "user-agent": "curl/8.7.1", accept: "*/*" });
  let method: string | undefined, url: string | undefined, data: string | undefined, output: string | undefined;
  let save: string | undefined, send: string | undefined, written: string | undefined;
  const form = new FormData();
  let multipart = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === "-s") continue;
    else if (arg === "-X") method = args[++at];
    else if (arg === "-H") { const header = args[++at]; const colon = header.indexOf(":"); headers.set(header.slice(0, colon).trim(), header.slice(colon + 1).trim()); }
    else if (arg === "-d") data = data === undefined ? args[++at] : `${data}&${args[++at]}`;
    else if (arg === "-F") {
      const [name, value] = args[++at].split(/=(.*)/s);
      if (!value.startsWith("@")) form.append(name, value);
      else {
        const file = value.slice(1);
        if (!(file in files)) throw new Error(`curl -F: there is no file ${file}`);
        form.append(name, new Blob([files[file]], { type: "application/octet-stream" }), path.basename(file));
      }
      multipart = true;
    }
    else if (arg === "-o") output = args[++at];
    else if (arg === "-w") written = args[++at];
    else if (arg === "-c") save = args[++at];
    else if (arg === "-b") send = args[++at];
    else if (arg.startsWith("-")) throw new Error(`the runner does not know curl's ${arg}`);
    else if (url) throw new Error(`curl names two addresses: ${url} and ${arg}`);
    else url = arg;
  }
  if (!url) throw new Error("curl names no address");
  if (send && cookies.has(send)) headers.set("cookie", cookies.get(send)!);
  if (data !== undefined && !headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
  const response = await fetch(url, {
    method: method ?? (data !== undefined || multipart ? "POST" : "GET"),
    headers,
    ...(multipart ? { body: form } : data !== undefined ? { body: data } : {}),
  });
  if (save) cookies.set(save, response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "));
  const body = await response.text();
  const after = written === undefined ? "" : written.replaceAll("%{http_code}", String(response.status)).replaceAll("\\n", "\n");
  if (/%\{/.test(after)) throw new Error(`the runner knows only %{http_code} in curl -w: ${written}`);
  return (output === "/dev/null" ? "" : body) + after;
}

// ---------------------------------------------------------------------------
// JavaScript, as Node runs a file

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** What one JavaScript file prints, run as a module with Node's globals. The
 * imports the pages use: `openAsBlob` from `node:fs`, which reads the files a
 * reader saved beside the script, and the names another file beside it
 * exports, such as `import { request } from "./dezfil.mjs";`, which runs that
 * file first, in a scope of its own. */
export async function runScript(code: string, files: Record<string, string>): Promise<string> {
  const printed: string[] = [];
  const body = code.replace(/^import \{ openAsBlob \} from "node:fs";$/m, "").replace(/^import \{ ([\w, ]+) \} from "\.\/([\w.-]+\.mjs)";$/gm, (_line, names: string, file: string) => {
    if (!(file in files)) throw new Error(`import: there is no file ${file} beside the script`);
    const source = files[file].replace(/^export (?=(?:async )?function |const |let )/gm, "");
    if (/^\s*(?:import|export)\b/m.test(source)) throw new Error(`import: ${file} itself imports or exports in a way the runner does not know`);
    return `const { ${names} } = await (async () => {\n${source}\nreturn { ${names} };\n})();`;
  });
  if (/^\s*import\b/m.test(body)) throw new Error("the runner gives a script only openAsBlob from node:fs and the files beside it");
  const openAsBlob = async (file: string) => {
    if (!(file in files)) throw new Error(`openAsBlob: there is no file ${file}`);
    return new Blob([files[file]]);
  };
  const console = { log: (...values: unknown[]) => { printed.push(values.map(String).join(" ")); } };
  await new AsyncFunction("fetch", "console", "openAsBlob", body)(globalThis.fetch, console, openAsBlob);
  return printed.map((line) => `${line}\n`).join("");
}

// ---------------------------------------------------------------------------
// An instance of its own

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const modules = import.meta.glob("/src/app/api/**/route.ts") as Record<string, () => Promise<Record<string, Handler>>>;
const routes = Object.entries(modules).map(([file, load]) => {
  const keys: string[] = [];
  const pattern = file.replace("/src/app", "").replace("/route.ts", "").split("/").map((part) => {
    if (part.startsWith("[")) { keys.push(part.slice(1, -1)); return "([^/]+)"; }
    return part;
  }).join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys, load };
}).sort((a, b) => a.keys.length - b.keys.length);
/** The paths the proxy runs for, as its matcher names them; the others gate
 * in their own route. */
const PROXIED = new RegExp(`^${config.matcher[0]}$`);

/** The addresses the instance answers at: the one the page's calls name,
 * and the one the server reaches itself at. Every other address fails. */
export interface OwnInstance { addresses: string[]; directory: string; close: () => Promise<void> }

/**
 * A new, empty instance in a folder of its own under the run's scratch
 * data folder: the shipped proxy and route handlers, answering every call
 * made to one of its addresses in this process. No socket is opened, so no
 * server on any port is reached.
 */
export async function ownInstance(address: string, port: string): Promise<OwnInstance> {
  const scratch = process.env.DEZFIL_DATA_DIR;
  if (!scratch) throw new Error("An instance of its own needs a scratch DEZFIL_DATA_DIR");
  // A run can name a scratch folder that nothing has made yet, as the
  // pipeline does.
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "page-calls-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  vi.stubEnv("PORT", port);
  closeMetadataDb(); resetQueryInstance();
  const addresses = [new URL(address).origin, `http://127.0.0.1:${port}`];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input, init));
    const url = new URL(request.url);
    if (!addresses.includes(url.origin)) throw new Error(`${url.origin} is not this instance; a page's calls reach only it`);
    const gate = PROXIED.test(url.pathname) ? await proxy(new NextRequest(request.clone())) : null;
    if (gate && gate.headers.get("x-middleware-next") !== "1") return gate;
    for (const route of routes) {
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      const handler = (await route.load())[request.method];
      if (!handler) throw new Error(`No handler for ${request.method} ${url.pathname}`);
      const response = await handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]))) });
      const answer = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const cookie of gate?.headers.getSetCookie() ?? []) answer.headers.append("set-cookie", cookie);
      return answer;
    }
    throw new Error(`No route answers ${request.method} ${url.pathname}`);
  });
  return {
    addresses, directory,
    close: async () => {
      await laneSettled(); closeMetadataDb(); resetQueryInstance();
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
