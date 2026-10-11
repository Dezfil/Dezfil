import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { issueSession } from "@/lib/auth/credentials";
import { resetQueryInstance } from "@/lib/duckdb";
import { getAccount } from "@/lib/metadata/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetSecretKeyCache } from "@/lib/secrets";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { testAccountScope } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import { startLoopbackCatalogue, type LoopbackCatalogue } from "../../../test-support/templates/catalogue";
import { resetCatalogueForTests } from "./catalogue";
import * as shipped from "./shipped-index";

/**
 * The installed set across a restart, in a second process. This process
 * downloads a template while the catalogue lists it and opens a shipped
 * one, so the engine holds copies of both templates' data, and leaves an
 * admission's staging behind as a stopped process would. A new process,
 * started over the same data folder with the catalogue blocked by the
 * egress rules, boots as the server boots (`restart.child.test.ts`): the
 * shipped and the downloaded template open, draw and copy, the catalogue is
 * refused, the boot sweep kept what the templates need and removed the
 * staging left behind, and the storage read counts the downloads and the
 * engine's copies under Templates, a file with two names once. The child's
 * exit code is the assertion, and it sends the catalogue nothing.
 */

keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
let root: string;
let built: string;
let catalogue: LoopbackCatalogue;
let A1: BuiltTemplate, C1: BuiltTemplate, W1: BuiltTemplate;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-restart-"));
  A1 = await buildTemplate(path.join(built, "a1"), { id: "harbour-stations", version: 1 });
  C1 = await buildTemplate(path.join(built, "c1"), { id: "quiet-park", version: 1, title: "Quiet park" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  await mkdir(path.join(process.cwd(), ".claude/test-data"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".claude/test-data", "templates-restart-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(root, "data"));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "localhost,127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32));
  closeMetadataDb();
  resetQueryInstance();
  resetSecretKeyCache();
  resetCatalogueForTests();
  catalogue = await startLoopbackCatalogue();
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl);
  await catalogue.publish([A1, W1]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await catalogue.close();
  resetCatalogueForTests();
  resetQueryInstance();
  closeMetadataDb();
  vi.unstubAllEnvs();
  resetSecretKeyCache();
  await rm(root, { recursive: true, force: true });
});

async function call(method: string, route: string, secret: string) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method, headers: { cookie: `dezfil_session=${secret}`, origin: ORIGIN },
  })));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

/** Every file under `folder` with its device and inode, read here. */
async function filesUnder(folder: string, keep: (name: string) => boolean = () => true) {
  const out: { file: string; size: number; key: string }[] = [];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !keep(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const seen = await lstat(file);
    out.push({ file, size: seen.size, key: `${seen.dev}:${seen.ino}` });
  }
  return out;
}

describe("after a restart with the catalogue blocked", () => {
  it("a new process over the same data folder opens and copies the shipped and the downloaded templates and counts the downloads under Templates", async () => {
    const shippedDir = await writeShippedFolder(path.join(root, "shipped"), [C1]);
    vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(shippedDir);
    const db = metadataDb();
    testAccountScope(db, "admin");
    testAccountScope(db, "member");
    db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
    const member = issueSession(getAccount("member", db)!, db, Date.now()).secret;

    // Two downloaded while listed, a map and a workflow example; all three
    // opened, so the engine holds copies of their data, the workflow's
    // bundled results among them, which no other template holds.
    expect((await call("POST", "/api/templates/refresh", member)).status).toBe(200);
    for (const id of ["harbour-stations", "busy-stations"]) {
      expect((await call("POST", `/api/templates/${id}/fetch`, member)).body, id).toMatchObject({ version: 1, downloaded: true });
    }
    for (const layer of ["quiet-park.1.layer.layer-stations", "harbour-stations.1.layer.layer-stations", "busy-stations.1.layer.layer-rings"]) {
      expect((await call("GET", `/api/layers/template.${layer}/render`, member)).body, layer).toMatchObject({ ok: true });
    }
    const data = path.join(root, "data");
    const tables = path.join(data, "tables");
    // What a stopped process left: an admission's own staging.
    const left = `template-${randomUUID()}.parquet`;
    await writeFile(path.join(tables, left), Buffer.alloc(64, 0x61));

    // Counted here, by this test: every file under `templates/` and the
    // engine's copies named by content, each inode once.
    const counted = [
      ...await filesUnder(path.join(data, "templates")),
      ...await filesUnder(tables, (name) => /^template-[0-9a-f]{64}\.parquet$/.test(name)),
    ];
    const once = new Map(counted.map((file) => [file.key, file.size]));
    // The workflow's results are the same files under two names.
    expect(counted.length - once.size).toBe(2);
    const templates = { bytes: [...once.values()].reduce((sum, size) => sum + size, 0), files: once.size };
    const shippedCopies = await Promise.all([...C1.files.binaries].filter(([name]) => name.endsWith(".parquet")).map(async ([, bytes]) => {
      const name = `template-${createHash("sha256").update(bytes).digest("hex")}.parquet`;
      return [name, (await lstat(path.join(tables, name))).ino] as const;
    }));
    expect(shippedCopies.length).toBeGreaterThan(0);
    closeMetadataDb();
    resetQueryInstance();
    const sent = catalogue.requests.length;

    const vitest = path.join(process.cwd(), "node_modules", ".bin", "vitest");
    const child = await promisify(execFile)(vitest, ["run", "src/lib/templates/restart.child.test.ts"], {
      env: {
        ...process.env,
        NEXT_RUNTIME: "nodejs",
        DEZFIL_TEMPLATES_RESTART_CHILD: "1",
        DEZFIL_TEMPLATES_RESTART_SHIPPED: shippedDir,
        DEZFIL_TEMPLATES_RESTART_EXPECT: JSON.stringify({ templates, shippedCopies: Object.fromEntries(shippedCopies), left }),
        // The catalogue is blocked: its address stands, the egress rules refuse it.
        DEZFIL_EGRESS_ALLOWLIST: "",
      },
      timeout: 110_000,
    }).catch((error: { stdout?: string; stderr?: string }) => {
      throw new Error(`the restarted process failed:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    });
    expect(child.stdout).toMatch(/1 passed/);
    expect(catalogue.requests).toHaveLength(sent);
  }, 120_000);
});
