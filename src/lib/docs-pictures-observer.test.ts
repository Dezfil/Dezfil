// The picture script's request observer. The script reads an empty request
// file at the end of a run as "the server opened no request", which is only
// worth something if the observer, preloaded into a process, really writes a
// row for a request that process opens. So a child process is started with
// the observer preloaded, as the server is, and the rows it wrote for its
// loopback requests are read back.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const observer = pathToFileURL(fileURLToPath(new URL("../../scripts/docs-pictures-observer.mjs", import.meta.url))).href;
const scratch = mkdtempSync(join(tmpdir(), "dezfil-docs-observer-"));
let server: Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Run a script in a child with the observer preloaded and return the
 * observer's file as rows, or null when it was never created. */
async function observed(name: string, code: string, options: { preload?: "argument" | "environment" } = {}) {
  const file = join(scratch, `${name}.ndjson`);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, DEZFIL_DOCS_REQUEST_LOG: file };
  const args = ["--input-type=module", "-e", code];
  if (options.preload === "environment") env.NODE_OPTIONS = `--import=${observer}`;
  else args.unshift(`--import=${observer}`);
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code_] = await once(child, "exit");
  expect(code_, stderr).toBe(0);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the picture script's request observer", () => {
  it("writes a row for each loopback request a preloaded process opens, through http and through fetch", async () => {
    const rows = await observed("both", `
      import http from "node:http";
      await new Promise((resolve, reject) => http.get("http://127.0.0.1:${port}/through-http?q=1", (r) => { r.resume(); r.on("end", resolve); }).on("error", reject));
      await (await fetch("http://127.0.0.1:${port}/through-fetch")).text();
    `);
    expect(seen).toEqual(expect.arrayContaining(["GET /through-http?q=1", "GET /through-fetch"]));
    expect(rows?.map(({ engine, method, host, path }) => ({ engine, method, host, path }))).toEqual([
      { engine: "http", method: "GET", host: `127.0.0.1:${port}`, path: "/through-http?q=1" },
      { engine: "fetch", method: "GET", host: `127.0.0.1:${port}`, path: "/through-fetch" },
    ]);
  });

  it("is carried to a process that takes it from NODE_OPTIONS, as the server's forks do", async () => {
    const rows = await observed("environment", `await (await fetch("http://127.0.0.1:${port}/from-options", { method: "POST", body: "x" })).text();`, { preload: "environment" });
    expect(rows?.map(({ engine, method, path }) => ({ engine, method, path }))).toEqual([{ engine: "fetch", method: "POST", path: "/from-options" }]);
  });

  it("leaves an empty file, not a missing one, when the process opens no request", async () => {
    expect(await observed("none", "await new Promise((resolve) => setTimeout(resolve, 10));")).toEqual([]);
  });

  it("writes no header and no body", async () => {
    const rows = await observed("private", `await (await fetch("http://127.0.0.1:${port}/private", { method: "POST", headers: { authorization: "Bearer not-for-the-log" }, body: "secret body" })).text();`);
    expect(JSON.stringify(rows)).not.toMatch(/not-for-the-log|secret body/);
  });
});
