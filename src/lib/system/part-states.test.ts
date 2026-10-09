import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { GET as readAssistant } from "@/app/api/assistant/route";
import { GET as readHealth } from "@/app/api/health/route";
import { GET as readSettings } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { queryEngineExtensions } from "@/lib/duckdb";
import { renderStats } from "@/lib/export/render-image";
import { getAccount } from "@/lib/metadata/accounts";
import * as metadata from "@/lib/metadata/db";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { readInstanceSettings } from "@/lib/settings/read";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { probeTilerVersion } from "@/lib/tiles/tiler";
import type { PartStates } from "./part-states";

/**
 * The parts block of the configuration read: each part's state as the
 * Status rows show it, read without starting anything. Reading the
 * configuration, and the other reads System makes when it opens (the
 * readiness check and the assistant's status), create no engine, launch no
 * browser, run no build and start no program: the query engine's version
 * comes from the library itself, whether it started and what it loaded from
 * what the engine recorded as it started; the tile builder and the image
 * renderer are found by a file check of where their settings point, never
 * by running them; the tile builder's version shows once the server has run
 * it. The stand-in programs here note any run in a file of their own.
 */

keepRequestsOnThisMachine();

/** Every program this process starts, by how it was started. */
const started = vi.hoisted(() => ({ programs: [] as string[], launches: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const ways = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
  const counted = Object.fromEntries(ways.map(way => [way, (...args: unknown[]) => {
    started.programs.push(`${way} ${String(args[0])}`);
    return (real[way] as (...given: unknown[]) => unknown)(...args);
  }]));
  return { ...real, ...counted, default: { ...real, ...counted } };
});
vi.mock("@/lib/export/render-driver", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/export/render-driver")>();
  return { ...real, puppeteerDriver: async () => {
    const driver = await real.puppeteerDriver();
    return { launch: (...args: Parameters<typeof driver.launch>) => { started.launches += 1; return driver.launch(...args); } };
  } };
});
/** The engine's record of what it loaded, the real one unless a test says otherwise. */
vi.mock("@/lib/duckdb", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/duckdb")>();
  return { ...real, queryEngineExtensions: vi.fn(real.queryEngineExtensions) };
});

const ORIGIN = "http://instance.test";
const SCRATCH = path.join(process.cwd(), ".claude/test-data");

function fixture() {
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(path.join(SCRATCH, "part-states-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  // A file, as the server keeps it, so the read can name it.
  const db = metadata.open(path.join(dir, "metadata.sqlite"));
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const admin = issueSession(getAccount("admin", db)!, db, Date.now());
  const context = authenticateSession(admin.secret, db)!;
  const bin = mkdtempSync(path.join(SCRATCH, "part-programs-"));
  return { db, dir, bin, admin, context,
    close() { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); } };
}

let f: ReturnType<typeof fixture>;
let engines: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  f = fixture();
  started.programs = []; started.launches = 0;
  // An engine asked for here is counted and never made.
  engines = vi.spyOn(DuckDBInstance, "create").mockRejectedValue(new Error("No engine is made in this file."));
});
afterEach(() => f.close());

/** A stand-in program that notes every run of it in a file beside it. */
function program(name: string, body = "exit 0"): { file: string; ran: () => boolean } {
  const file = path.join(f.bin, name);
  const log = path.join(f.bin, `${name}.ran`);
  writeFileSync(file, `#!/bin/sh\n: > '${log}'\n${body}\n`, { mode: 0o755 });
  return { file, ran: () => existsSync(log) };
}

const get = (url: string, cookie = true) => socketRequest(new Request(`${ORIGIN}${url}`,
  { headers: cookie ? { cookie: `dezfil_session=${f.admin.secret}` } : {} }));

async function partsRead(): Promise<PartStates> {
  const response = await readSettings(get("/api/instance/settings"));
  expect(response.status).toBe(200);
  return (await response.json()).parts as PartStates;
}

describe("the parts block of the configuration read", () => {
  it("reads every part's state, and System's reads on opening start no engine, no browser, no build and no program", async () => {
    const tiler = program("tiler"), browser = program("browser");
    vi.stubEnv("DEZFIL_TIPPECANOE", tiler.file);
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", browser.file);
    vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "3");
    const launches = renderStats().launches;

    const parts = await partsRead();
    expect((await readHealth(get("/api/health", false))).status).toBe(200);
    expect((await readAssistant(get("/api/assistant"))).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(parts).toEqual({
      query_engine: { version: expect.stringMatching(/^\d+\.\d+\.\d+$/), started: false, extensions: [] },
      tile_builder: { found: true, version: null },
      image_renderer: { found: true, imagesAtOnce: 3 },
      metadata_database: { file: "metadata.sqlite" },
    });
    // Nothing was started to answer.
    expect(engines).not.toHaveBeenCalled();
    expect(queryEngineExtensions()).toBeNull();
    expect(started.programs).toEqual([]);
    expect(started.launches).toBe(0);
    expect(renderStats().launches).toBe(launches);
    expect(tiler.ran()).toBe(false);
    expect(browser.ran()).toBe(false);
  });

  it("is the same block in the read the settings tool and a change answer with", () => {
    vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "2");
    const read = readInstanceSettings(f.context, f.db) as { parts?: PartStates };
    expect(read.parts?.image_renderer.imagesAtOnce).toBe(2);
    expect(read.parts?.metadata_database.file).toBe("metadata.sqlite");
    expect(engines).not.toHaveBeenCalled();
    expect(started.programs).toEqual([]);
  });

  it("reads a program missing where its setting points as not found, by a file check alone", async () => {
    vi.stubEnv("DEZFIL_TIPPECANOE", path.join(f.bin, "absent-tiler"));
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", "no-such-browser-on-the-search-path");
    const notRunnable = path.join(f.bin, "not-runnable");
    writeFileSync(notRunnable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    let parts = await partsRead();
    expect(parts.tile_builder).toEqual({ found: false, version: null });
    expect(parts.image_renderer.found).toBe(false);
    vi.stubEnv("DEZFIL_TIPPECANOE", notRunnable);
    parts = await partsRead();
    expect(parts.tile_builder.found).toBe(false);
    expect(started.programs).toEqual([]);
  });

  it("gives the tile builder's version once the server has run it, the number alone", async () => {
    const tiler = program("tiler", `echo "tippecanoe v2.79.0 built in ${f.bin}" >&2`);
    vi.stubEnv("DEZFIL_TIPPECANOE", tiler.file);
    expect((await partsRead()).tile_builder).toEqual({ found: true, version: null });
    expect(tiler.ran()).toBe(false);
    await probeTilerVersion();
    expect(tiler.ran()).toBe(true);
    const programs = started.programs.length;
    expect((await partsRead()).tile_builder).toEqual({ found: true, version: "2.79.0" });
    // The read itself ran nothing more.
    expect(started.programs).toHaveLength(programs);
  });

  it("reads a started engine as started with the extensions it loaded, in load order", async () => {
    const { queryEngineExtensions: loaded } = await import("@/lib/duckdb");
    vi.mocked(loaded).mockReturnValue(["spatial", "json"]);
    expect((await partsRead()).query_engine).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), started: true, extensions: ["spatial", "json"] });
    expect(engines).not.toHaveBeenCalled();
  });
});
