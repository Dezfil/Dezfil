import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/** A separate process, so an unhandled event is observed rather than failing
 * the runner: a native server whose handler owns reception, lets the
 * framework's proxy copy its buffered body back onto the request, writes a
 * refusal's head and holds the rest, while the caller leaves. */
function departure(afterwards: "nothing" | "unrelated") {
  return `
import http from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(${JSON.stringify(path.resolve("package.json"))});
const { getCloneableBody } = require("next/dist/server/body-streams");
const { installReception } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/lib/auth/reception.mjs")).href)});
const unhandled = [];
process.on("uncaughtException", error => unhandled.push(error.message));
process.on("unhandledRejection", reason => unhandled.push("rejection: " + reason?.message));
const copied = Promise.withResolvers();
const server = http.createServer(async (request, response) => {
  installReception(server, request, response, false);
  if (request.method === "GET") { response.end("answered"); return; }
  const body = getCloneableBody(request);
  body.cloneBodyStream().resume();
  await body.finalize();
  response.writeHead(401, { "content-type": "application/json" });
  request.socket.once("close", () => setImmediate(() => {
    if (${JSON.stringify(afterwards)} === "unrelated") request.emit("error", new Error("Unrelated failure after the caller left."));
  }));
  copied.resolve();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const caller = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/maps", headers: { "content-type": "application/json", "content-length": "2" } });
caller.on("error", () => {});
caller.end("{}");
await copied.promise;
await delay(50);
caller.destroy();
await delay(200);
const next = await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(5000) });
console.log(JSON.stringify({ unhandled, next: next.status, text: await next.text() }));
server.closeAllConnections(); server.close();
`;
}

async function observe(afterwards: "nothing" | "unrelated") {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", departure(afterwards)], { timeout: 20000 });
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as { unhandled: string[]; next: number; text: string };
}

describe("a caller who leaves after the framework copied the body back", () => {
  it("raises no unhandled event, and the next request is answered", async () => {
    expect(await observe("nothing")).toEqual({ unhandled: [], next: 200, text: "answered" });
  });

  it("leaves an unrelated failure on the departed request as visible as before", async () => {
    expect(await observe("unrelated")).toEqual({ unhandled: ["Unrelated failure after the caller left."], next: 200, text: "answered" });
  });
});
