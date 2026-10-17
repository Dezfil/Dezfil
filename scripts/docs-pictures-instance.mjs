// The picture script's instance: a production server of this checkout's
// build on a port of its own, over a scratch directory the script creates and
// removes, seeded through the documented API. Nothing here opens a data
// directory other than the scratch one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { journeyApi } from "./journey-http.mjs";
import { provisionJourney } from "./journey-auth.mjs";

/** The two made-up people the seeded scenes show, and what they share. */
export const PEOPLE = {
  first: { name: "Lena Ortiz", email: "lena@example.test", password: "tide tables at noon" },
  second: { name: "Jonas Berg", email: "jonas@example.test", password: "lantern maps at dusk" },
};
export const PROJECT = { name: "Coastal survey", note: "Shared by Lena and Jonas." };

/** The repository's own fixtures, uploaded as data and filed in the
 * shared project. */
export const FIXTURES = ["e2e/fixtures/stations.csv", "e2e/fixtures/districts.geojson", "e2e/fixtures/paths.geojson", "e2e/fixtures/flows.csv"];

/** Files Next reads into the server's environment from the checkout: a run
 * that found one would not be an instance of the build alone. */
const ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];

const expectStatus = (response, status, label) => {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.json)}`);
  return response.json;
};

/** A port the system hands out now, on loopback. */
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

/** The scratch directory: the data directory, the catalogue folder and the
 * request observer's file, all under one folder the run removes. */
export async function makeScratch() {
  const folder = await mkdtemp(path.join(tmpdir(), "dezfil-docs-pictures-"));
  const scratch = { folder, data: path.join(folder, "data"), catalogue: path.join(folder, "catalogue"), requests: path.join(folder, "requests.ndjson") };
  await mkdir(scratch.data);
  await mkdir(scratch.catalogue);
  return scratch;
}

/**
 * The template catalogue as a folder, written from the shipped templates'
 * own files: each one's facts, its pictures and its record's archive size
 * and digest. Every entry names a shipped id, and a shipped id is drawn from
 * the image whatever the catalogue lists, so the Templates page draws the
 * same three cards on every run, reads the catalogue as listed (no line about
 * a missing catalogue), and nothing is downloaded or fetched. The archive
 * each entry names is never read for the same reason, so none is written.
 */
export async function writeCatalogue(root, folder) {
  const shipped = JSON.parse(await readFile(path.join(root, "templates/index.json"), "utf8"));
  const templates = [];
  for (const { id, version } of shipped.templates) {
    const source = path.join(root, "templates", id, String(version));
    const facts = JSON.parse(await readFile(path.join(source, "template.json"), "utf8"));
    const record = JSON.parse(await readFile(path.join(source, "record.json"), "utf8"));
    const pictures = {};
    for (const [theme, file] of Object.entries(facts.pictures)) {
      const target = `${id}/${version}/${theme}.png`;
      await mkdir(path.join(folder, id, String(version)), { recursive: true });
      await copyFile(path.join(source, file), path.join(folder, target));
      pictures[theme] = target;
    }
    templates.push({ facts, size: record.archive.size, sha256: record.archive.sha256, archive: `${id}/${version}/template.zip`, pictures });
  }
  await writeFile(path.join(folder, "index.json"), `${JSON.stringify({ formatVersion: 1, templates }, null, 2)}\n`);
  return templates.map((entry) => entry.facts.id);
}

/** Refuse a checkout that cannot give an instance of its own build alone. */
export function assertBuiltCheckout(root) {
  assert.ok(existsSync(path.join(root, ".next/BUILD_ID")), `${root} has no production build: run npm run build there first.`);
  const found = ENV_FILES.filter((file) => existsSync(path.join(root, file)));
  assert.deepEqual(found, [], `${found.join(", ")} would set the server's environment: run the script from a checkout without them, such as a detached worktree.`);
}

/**
 * Start `next start` from the checkout, on loopback, with the request
 * observer first in the preload chain and an environment of the script's own:
 * the scratch data directory and catalogue folder, telemetry off, nothing
 * inherited but the path and the home folder.
 */
export async function startServer({ root, port, scratch }) {
  const observer = pathToFileURL(path.join(root, "scripts/docs-pictures-observer.mjs")).href;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    TZ: "UTC",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--import=${observer}`,
    DEZFIL_DATA_DIR: scratch.data,
    DEZFIL_TEMPLATES_CATALOGUE: scratch.catalogue,
    DEZFIL_DOCS_REQUEST_LOG: scratch.requests,
  };
  const child = spawn(process.execPath, ["--import=./scripts/ingress-preload.mjs", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`The instance stopped while starting:\n${output}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (attempt === 239) throw new Error(`The instance did not answer /api/health within a minute:\n${output}`);
  }
  assert.ok(existsSync(scratch.requests), "The request observer did not load into the server.");
  return {
    base,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}

/** The requests the server opened during the run, from the observer's file. */
export async function serverRequests(scratch) {
  const text = await readFile(scratch.requests, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Seed the instance as the seeded scenes need it, all through the
 * documented API: the first account through the setup operation, a second
 * account invited and redeemed, a project the two share, the three shipped
 * templates copied in their own kinds, and the repository's fixtures
 * uploaded and filed in the project. Returns the first account's browser
 * cookie, for the seeded scenes' browser.
 */
export async function seed(base, root) {
  const first = await provisionJourney(base, PEOPLE.first);
  assert.ok(first.setupRequired, "The first account was made through setup.");
  const lena = journeyApi(base, { token: first.token });

  const invited = expectStatus(await lena("POST", "/api/users", { body: { name: PEOPLE.second.name, email: PEOPLE.second.email } }), 201, "invite the second account");
  const secret = new URLSearchParams(new URL(invited.signInUrl).hash.slice(1)).get("secret");
  const redeemed = await fetch(`${base}/api/auth/redeem`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ secret, password: PEOPLE.second.password }) });
  assert.equal(redeemed.status, 200, "the second account sets its password");
  await redeemed.body?.cancel();
  const second = await provisionJourney(base, PEOPLE.second);
  const jonas = expectStatus(await journeyApi(base, { token: second.token })("GET", "/api/account"), 200, "read the second account").account;

  const project = expectStatus(await lena("POST", "/api/projects", { body: PROJECT }), 201, "create the shared project");
  expectStatus(await lena("PUT", `/api/projects/${project.id}/people/${jonas.sqlName}`, { body: { role: "editor" } }), 200, "share the project");

  const templates = expectStatus(await lena("GET", "/api/templates"), 200, "list the templates").templates.filter((card) => card.origin === "shipped");
  assert.equal(templates.length, 3, "the three shipped templates are listed");
  for (const card of templates) expectStatus(await lena("POST", `/api/templates/${card.id}/copy`, { body: {} }), 201, `copy ${card.id}`);

  const tables = [];
  for (const fixture of FIXTURES) {
    const form = new FormData();
    form.append("file", new Blob([await readFile(path.join(root, fixture))]), path.basename(fixture));
    tables.push(expectStatus(await lena("POST", "/api/tables", { form }), 201, `upload ${fixture}`).id);
  }
  expectStatus(await lena("PATCH", `/api/projects/${project.id}/members`, { body: { addTables: tables } }), 200, "file the fixtures in the project");

  return { cookie: first.cookie };
}
