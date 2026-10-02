#!/usr/bin/env node
// Outside-sandbox proof. Run from a built, detached checkout; every store and
// server belongs to this probe. Container mode tests the final image unchanged.
//   node scripts/admin-recovery-probe.mjs checkout
//   node scripts/admin-recovery-probe.mjs container dezfil:admin-recovery
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2], image = process.argv[3];
if (!["checkout", "container"].includes(mode) || (mode === "container" && !image)) {
  throw new Error("Usage: node scripts/admin-recovery-probe.mjs checkout | container IMAGE");
}
const scratch = mkdtempSync(path.join(tmpdir(), "dezfil-admin-recovery-probe-"));
const name = `dezfil-admin-recovery-${randomUUID()}`, volume = `${name}-data`;
let server, base, output = "", stage = "start", checks = 0;
const secrets = [];
function check(ok, label) { checks++; if (!ok) throw new Error(label); }
function docker(args) { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
async function port() {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const number = socket.address().port; await new Promise(resolve => socket.close(resolve));
  check(number !== 3000, "owned port"); return number;
}
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).status === 200) return; } catch {}
    await delay(500);
  }
  throw new Error("server readiness");
}
async function start() {
  if (mode === "container") {
    if (!base) {
      docker(["volume", "create", volume]);
      const hostPort = await port();
      docker(["run", "-d", "--name", name, "--mount", `type=volume,src=${volume},dst=/data`, "-p", `127.0.0.1:${hostPort}:3000`, image]);
      base = `http://127.0.0.1:${hostPort}`;
    } else docker(["start", name]);
  } else {
    base ??= `http://127.0.0.1:${await port()}`;
    server = spawn(process.execPath, ["--import=./scripts/ingress-preload.mjs", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", new URL(base).port],
      { env: { ...process.env, DEZFIL_DATA_DIR: scratch }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", chunk => { output += chunk; }); server.stderr.on("data", chunk => { output += chunk; });
  }
  await ready();
}
async function stop() {
  if (mode === "container") docker(["stop", name]);
  else if (server && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
}
async function api(method, route, body, credential) {
  const response = await fetch(base + route, { method, redirect: "manual", headers: {
    origin: base, "content-type": "application/json", ...(credential ?? {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json().catch(() => null);
  return { status: response.status, json, cookie: response.headers.getSetCookie().find(value => value.startsWith("dezfil_session="))?.split(";")[0] };
}
function recover(oneOff = false) {
  const args = ["npm", "run", "--silent", "admin:recover", "--", "--data-dir", mode === "container" ? "/data" : scratch, "--origin", base];
  let terminal;
  if (mode === "container") terminal = docker(oneOff
    ? ["run", "--rm", "-t", "--mount", `type=volume,src=${volume},dst=/data`, image, ...args]
    : ["exec", "-t", name, ...args]);
  else {
    // BSD and util-linux script both allocate a real PTY without recording a file.
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    terminal = execFileSync("script", process.platform === "darwin" ? ["-q", "/dev/null", ...args]
      : ["-q", "-e", "-c", args.map(quote).join(" "), "/dev/null"],
    { encoding: "utf8", env: { ...process.env, DEZFIL_DATA_DIR: scratch }, stdio: ["ignore", "pipe", "pipe"] });
  }
  const links = terminal.match(/https?:\/\/[^\s]+\/accept#secret=dz_link_[\w-]+/g) ?? [];
  check(links.length === 1 && terminal.includes('Account: "recovery@example.test"') && /Expires: \d{4}-/.test(terminal), "single terminal disclosure");
  const secret = new URLSearchParams(new URL(links[0]).hash.slice(1)).get("secret");
  secrets.push(secret); return secret;
}
const password = "field notebooks before sunrise", replacement = "paper cranes after midnight";
try {
  await start(); stage = "setup";
  check((await api("GET", "/api/auth/entry")).json.setupRequired, "fresh probe store");
  const admin = await api("POST", "/api/auth/setup", { name: "Recovery probe", email: "recovery@example.test", password });
  check(admin.status === 200 && admin.cookie, "setup");
  const oldSession = { cookie: admin.cookie };
  const token = await api("POST", "/api/account/tokens", { name: "API and MCP" }, oldSession);
  check(token.status === 201, "token creation"); const bearer = { authorization: `Bearer ${token.json.secret}` };
  const map = await api("POST", "/api/maps", { name: "Retained recovery content" }, oldSession);
  check(map.status === 201, "owned content");
  const invitation = await api("POST", "/api/users", { name: "Other account", email: "other@example.test" }, oldSession);
  check(invitation.status === 201, "other account invitation");
  const invitedSecret = new URLSearchParams(new URL(invitation.json.signInUrl).hash.slice(1)).get("secret");
  const other = await api("POST", "/api/auth/redeem", { secret: invitedSecret, password });
  check(other.status === 200, "other account redemption");
  const otherCookie = { cookie: other.cookie };
  const otherBefore = (await api("GET", "/api/auth/session", undefined, otherCookie)).json;
  stage = "live issuance"; const live = recover();
  check((await api("GET", "/api/maps", undefined, oldSession)).status === 401, "browser session revoked");
  check((await api("GET", "/api/maps", undefined, bearer)).status === 401, "API token revoked");
  check((await api("POST", "/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer)).status === 401, "MCP token revoked");
  check((await api("POST", "/api/auth/sign-in", { email: "recovery@example.test", password })).status === 401, "password revoked");
  check(JSON.stringify((await api("GET", "/api/auth/session", undefined, otherCookie)).json) === JSON.stringify(otherBefore), "other account unchanged");
  check((await api("POST", "/api/auth/redeem", { secret: live, password: "password" })).status === 400, "shipped password rule");
  const redeemed = await api("POST", "/api/auth/redeem", { secret: live, password: replacement });
  check(redeemed.status === 200 && redeemed.json.account.id === admin.json.account.id && redeemed.json.account.isAdmin, "live redemption retains admin identity");
  check((await api("GET", `/api/maps/${map.json.id}`, undefined, { cookie: redeemed.cookie })).json.name === map.json.name, "owned content retained");
  check((await api("POST", "/api/auth/redeem", { secret: live, password })).status === 401, "single use");
  if (mode === "container") {
    stage = "live one-off issuance"; const oneOff = recover(true);
    check((await api("POST", "/api/auth/redeem", { secret: oneOff, password: replacement })).status === 200, "live one-off redemption");
  }
  stage = "stopped issuance and restart"; await stop(); const stopped = recover(true); await start();
  check((await api("POST", "/api/auth/redeem", { secret: stopped, password: replacement })).status === 200, "stopped issuance survives restart");
  check((await api("POST", "/api/auth/sign-in", { email: "recovery@example.test", password: replacement })).status === 200, "new password signs in");
  stage = "server disclosure";
  if (mode === "container") {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    check(logs.status === 0, "read server logs"); output += logs.stdout + logs.stderr;
  }
  for (const secret of secrets) check(!output.includes(secret), "no recovery secret in server logs");
  console.log(`PASS: ${mode} admin recovery, ${checks} checks.`);
} catch {
  // Never dump child output, HTTP bodies or assertion values containing credentials.
  console.error(`FAIL: admin recovery probe at ${stage}. No credential output retained.`); process.exitCode = 1;
} finally {
  await stop().catch(() => {});
  if (mode === "container") {
    try { docker(["rm", "-f", name]); } catch {}
    try { docker(["volume", "rm", volume]); } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
}
