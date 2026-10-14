#!/usr/bin/env node
// Outside-sandbox proof. Run from a built, detached checkout; every store and
// server belongs to this probe. Container mode tests the final image unchanged.
//   node scripts/admin-recovery-probe.mjs checkout
//   node scripts/admin-recovery-probe.mjs container dezfil:admin-recovery
//   node scripts/admin-recovery-probe.mjs browser
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deleteOriginal, assertSetupClosed, assertOriginalIdentity } from "./deletion-recovery-checks.mjs";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2], image = process.argv[3];
if (!["checkout", "container", "browser"].includes(mode) || (mode === "container" && !image)) {
  throw new Error("Usage: node scripts/admin-recovery-probe.mjs checkout | container IMAGE | browser");
}
const scratchRoot = process.env.DEZFIL_DATA_DIR;
assert.ok(scratchRoot && path.isAbsolute(scratchRoot), "set a fresh scratch DEZFIL_DATA_DIR");
mkdirSync(scratchRoot, { recursive: true }); assert.deepEqual(readdirSync(scratchRoot), [], "empty scratch only");
const scratch = mkdtempSync(path.join(scratchRoot, "recovery-"));
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
      docker(["run", "-d", "--name", name, "--mount", `type=volume,src=${volume},dst=/data`, "-p", `127.0.0.1:${hostPort}:3000`, "-v", `${process.cwd()}/scripts:/probes:ro`, image]);
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
async function api(method, route, body, credential, revision) {
  const response = await fetch(base + route, { method, redirect: "manual", headers: {
    origin: base, "content-type": "application/json", ...(credential ?? {}), ...(revision ? { "X-Edit-Revision": revision } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json().catch(() => null);
  return { status: response.status, json, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
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
  if (mode === "browser") {
    stage = "browser redemption";
    const browser = spawn("npx", ["playwright", "test", "e2e/admin-recovery.spec.ts"], {
      env: { ...process.env, DEZFIL_DATA_DIR: scratch, DEZFIL_BASE_URL: base, DEZFIL_E2E_FIRST_RUN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Keep failure output private: browser errors may contain the fragment URL.
    browser.stdout.resume(); browser.stderr.resume();
    check((await once(browser, "exit"))[0] === 0, "browser recovery journey");
    check(!output.includes("dz_link_"), "no recovery secret in server logs");
  } else {
  check((await api("GET", "/api/auth/entry")).json.setupRequired, "fresh probe store");
  const original = await api("POST", "/api/auth/setup", { name: "Original probe", email: "original@example.test", password });
  check(original.status === 200 && original.cookie, "setup");
  const originalCookie = { cookie: original.cookie };
  const remainingInvitation = await api("POST", "/api/users", { name: "Recovery probe", email: "recovery@example.test", isAdmin: true }, originalCookie);
  check(remainingInvitation.status === 201, "remaining admin invitation");
  const remainingSecret = new URLSearchParams(new URL(remainingInvitation.json.signInUrl).hash.slice(1)).get("secret");
  const admin = await api("POST", "/api/auth/redeem", { secret: remainingSecret, password });
  check(admin.status === 200 && admin.cookie, "remaining admin redemption");
  const originalProject = await api("POST", "/api/projects", { name: "Adopted homes" }, originalCookie);
  check(originalProject.status === 201, "original project");
  check((await api("PUT", `/api/projects/${originalProject.json.id}/people/${admin.json.account.sqlName}`, { role: "editor" }, originalCookie)).status === 200, "remaining admin reaches homes");
  const transferredMap = await api("POST", "/api/maps", { name: "Retained recovery content", projectId: originalProject.json.id }, originalCookie);
  const transferredWorkflow = await api("POST", "/api/recipes", { name: "Retained recovery workflow", projectId: originalProject.json.id }, originalCookie);
  check(transferredMap.status === 201 && transferredWorkflow.status === 201, "original documents");
  for (const [kind, doc] of [["maps", transferredMap.json], ["recipes", transferredWorkflow.json.recipe]]) {
    check((await api("POST", `/api/${kind}/${doc.id}/transfer`, { to: admin.json.account.sqlName }, originalCookie, doc.editRevision)).status === 200, "transfer before deletion");
  }
  const homes = [["maps", transferredMap.json.id, admin.json.account.id], ["recipes", transferredWorkflow.json.recipe.id, admin.json.account.id]];
  stage = "original-profile deletion";
  await deleteOriginal((method, route, body) => api(method, route, body, { cookie: admin.cookie }), original.json.account);
  await assertSetupClosed(api);
  function retainedIdentity() {
    if (mode === "container") docker(["exec", name, "node", "--input-type=module", "-e", `import {createRequire} from 'node:module'; import {assertOriginalIdentity} from '/probes/deletion-recovery-checks.mjs'; const Database=createRequire('/app/server.js')('better-sqlite3'); const db=new Database('/data/metadata.sqlite'); try { assertOriginalIdentity(db,${JSON.stringify(original.json.account.id)},${JSON.stringify(homes)}); } finally { db.close(); }`]);
    else { const db = new Database(path.join(scratch, "metadata.sqlite")); try { assertOriginalIdentity(db, original.json.account.id, homes); } finally { db.close(); } }
  }
  retainedIdentity(); await stop(); await start(); await assertSetupClosed(api); retainedIdentity();
  check((await api("GET", "/api/account", undefined, originalCookie)).status === 401, "original credential revoked");
  const oldSession = { cookie: admin.cookie };
  const token = await api("POST", "/api/account/tokens", { name: "API and MCP" }, oldSession);
  check(token.status === 201, "token creation"); const bearer = { authorization: `Bearer ${token.json.secret}` };
  const map = transferredMap;
  check((await api("GET", `/api/maps/${map.json.id}`, undefined, oldSession)).status === 200, "transferred content retained");
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
  retainedIdentity(); await assertSetupClosed(api);
  stage = "server disclosure";
  if (mode === "container") {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    check(logs.status === 0, "read server logs"); output += logs.stdout + logs.stderr;
  }
  for (const secret of secrets) check(!output.includes(secret), "no recovery secret in server logs");
  }
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
