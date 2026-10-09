import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GET } from "@/app/api/instance/storage/route";
import { admits } from "@/lib/assistant/policy";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { cleanAbandonedDeletionCandidates } from "@/lib/auth/account-deletion-candidate-recovery";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { gateRequest } from "@/lib/auth/gate";
import { registerAccountFile } from "@/lib/ingest/file-ownership";
import { cleanIngestScratch } from "@/lib/ingest/scratch";
import { sweepTableArtifacts } from "@/lib/ingest/sweep";
import { createMap } from "@/lib/map-service";
import { getAccount } from "@/lib/metadata/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertLayer, type Layer } from "@/lib/metadata/maps";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { upsertTileRecord } from "@/lib/metadata/tiles";
import { clearServiceCaches } from "@/lib/settings/service-facts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { cleanTileScratch, sweepTileArchives } from "@/lib/tiles/build";
import { buildTools } from "@/lib/tools/tools";
import { STORAGE_KINDS, type StorageKind, type StorageRead } from "./storage-answer";
import { forgetStorageRead, readStorage } from "./storage";

/**
 * The storage read: what the data folder holds, by kind, from its names and
 * sizes and which files the metadata references, never a name, an owner or
 * a path. Leftover files are what the next restart's sweeps remove, held
 * here against the sweeps themselves. One walk at a time, its answer given
 * again for 30 seconds unless a cache's Clear came between, and a walk
 * stopped at 10 seconds, its reference read included, gives what it had
 * not finished as at least. Admins only; a link counts nothing.
 */

keepRequestsOnThisMachine();

/** Reads of the data folder's top, one per walk, and what a test does at a read or after the references. */
const watch = vi.hoisted(() => ({ root: "", walks: 0, onRead: null as null | ((dir: string) => void), afterReferences: null as null | (() => void) }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = ((dir: unknown, ...rest: unknown[]) => {
    if (String(dir) === watch.root) watch.walks += 1;
    watch.onRead?.(String(dir));
    return (real.readdir as (...given: unknown[]) => unknown)(dir, ...rest);
  }) as typeof real.readdir;
  return { ...real, readdir, default: { ...real, readdir } };
});
vi.mock("./storage-references", async importOriginal => {
  const real = await importOriginal<typeof import("./storage-references")>();
  return { readStorageReferences: (...args: Parameters<typeof real.readStorageReferences>) => {
    const references = real.readStorageReferences(...args);
    watch.afterReferences?.();
    return references;
  } };
});

const SCRATCH = path.join(process.cwd(), ".claude/test-data");
const ORIGIN = "http://instance.test";
let root: string, data: string;

function people() {
  const db = metadataDb();
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  const admin = issueSession(getAccount("admin", db)!, db, Date.now());
  const member = issueSession(getAccount("member", db)!, db, Date.now());
  const context = authenticateSession(admin.secret, db)!;
  return { db, admin, member, context, token: createApiToken(context, "Storage", db) };
}
let p: ReturnType<typeof people>;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(path.join(SCRATCH, "storage-"));
  data = path.join(root, "data");
  mkdirSync(data);
  vi.stubEnv("DEZFIL_DATA_DIR", data);
  closeMetadataDb();
  forgetStorageRead();
  Object.assign(watch, { root: data, walks: 0, onRead: null, afterReferences: null });
  p = people();
});
afterEach(() => {
  forgetStorageRead();
  closeMetadataDb();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A file of `size` bytes at `rel` under the data folder, all alike, so two of one size are byte-identical. */
function put(rel: string, size: number): void {
  mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
  writeFileSync(path.join(data, rel), Buffer.alloc(size, 0x61));
}
/** Every file under the data folder, by its path there. */
function filesNow(): string[] {
  return readdirSync(data, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(data, path.join(entry.parentPath, entry.name))).sort();
}
function table(scope: ReturnType<typeof testAccountScope>, id: string, name: string, file: string): void {
  insertTable(scope, { id, name, sourceFilename: `${name}.geojson`, format: "geojson", file, geometryColumn: "geometry", geometryType: "POLYGON",
    crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "2026-10-01T00:00:00Z", source: "upload", sourceParams: null, importedAt: null } as DataTable);
}
/** A layer on a new map with a tile record, the record being what keeps an archive. */
function tiledLayer(scope: ReturnType<typeof testAccountScope>, layerId: string, mapName: string): string {
  const map = createMap(scope, mapName);
  const at = "2026-10-01T00:00:00.000Z";
  insertLayer({ id: layerId, mapId: map.id, name: "Layer", sql: "SELECT 1", style: {}, visible: true, tooltip: null, popup: null, publishedFields: null,
    inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null, ordinal: 0, createdAt: at, updatedAt: at } as unknown as Layer);
  upsertTileRecord({ layerId, state: "ready", fingerprint: "fixture", error: null, featureCount: 4, builtAt: at });
  return map.id;
}
const read = (headers: Record<string, string> = { cookie: `dezfil_session=${p.admin.secret}` }) =>
  socketRequest(new Request(`${ORIGIN}/api/instance/storage`, { headers }));

const L_KEPT = "0b6f3c1e-7d1a-4a52-9c1e-000000000001", L_GONE = "0b6f3c1e-7d1a-4a52-9c1e-000000000002";

/** The fixture folder: each kind, an identical pair that differs only in
 * whether the metadata references it, and one of each leftover place. */
function fixtureFolder() {
  const scope = testAccountScope(p.db, "admin");
  table(scope, "table-kept", "kept", "tables/kept.parquet");
  const mapId = tiledLayer(scope, L_KEPT, "Kept map");
  registerAccountFile("admin", "tables/kept.parquet");
  const sizes: Record<string, [number, StorageKind]> = {
    "tables/kept.parquet": [1000, "tables"],
    "tables/orphan.parquet": [1000, "leftover_files"],
    [`tiles/${L_KEPT}.pmtiles`]: [2000, "tile_archives"],
    [`tiles/${L_GONE}.pmtiles`]: [2000, "leftover_files"],
    [`artifact-inputs/tiles/${L_KEPT}.json`]: [50, "tile_archives"],
    [`artifact-inputs/tiles/${L_GONE}.json`]: [50, "leftover_files"],
    [`tiles/scratch/${L_KEPT}.parquet`]: [300, "leftover_files"],
    "tmp/upload-0001.geojson": [400, "leftover_files"],
    "tmp/download-0002/part.bin": [100, "leftover_files"],
    "exports/project-0003/archive.zip": [500, "leftover_files"],
    [`thumbnails/${mapId}.png`]: [700, "thumbnails"],
    [`thumbnails/${mapId}.png.0a1b2c.tmp`]: [70, "leftover_files"],
    [`artifact-inputs/thumbnails/${mapId}.json`]: [30, "thumbnails"],
    [`artifact-inputs/thumbnails/${mapId}.json.3d4e5f.tmp`]: [20, "leftover_files"],
    "cache/geocode/answer-1.json": [60, "service_caches"],
    "cache/overpass/answer-2.json": [80, "service_caches"],
    "secret.key": [32, "other"],
    "account-deletions/journal.json": [40, "other"],
  };
  for (const [rel, [size]] of Object.entries(sizes)) put(rel, size);
  // A large folder and a file outside, each reached by a link inside: neither counts.
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "large.bin"), Buffer.alloc(1 << 20));
  symlinkSync(outside, path.join(data, "outside-folder"));
  symlinkSync(path.join(outside, "large.bin"), path.join(data, "tables", "linked.parquet"));
  return { sizes, mapId };
}

/** What the fixture says, each kind's bytes and count; the database's own files by their sizes now. */
function expected(sizes: Record<string, [number, StorageKind]>): Record<StorageKind, { bytes: number; files: number }> {
  const want = Object.fromEntries(STORAGE_KINDS.map(kind => [kind, { bytes: 0, files: 0 }])) as Record<StorageKind, { bytes: number; files: number }>;
  for (const [size, kind] of Object.values(sizes)) { want[kind].bytes += size; want[kind].files += 1; }
  for (const file of readdirSync(data).filter(name => name.startsWith("metadata.sqlite"))) {
    want.metadata_database.bytes += lstatSync(path.join(data, file)).size;
    want.metadata_database.files += 1;
  }
  // The ownership record of the kept table is the server's own record.
  for (const file of readdirSync(path.join(data, "file-owners"))) {
    want.other.bytes += lstatSync(path.join(data, "file-owners", file)).size;
    want.other.files += 1;
  }
  return want;
}

describe("the storage read", () => {
  it("gives each kind's size and count, each file once, the unreferenced of an identical pair as leftovers, links counting nothing; the sweeps leave exactly the rest", async () => {
    const { sizes } = fixtureFolder();
    const want = expected(sizes);
    const answer = await readStorage(p.context, p.db);
    for (const kind of STORAGE_KINDS) expect(answer.kinds[kind], kind).toEqual({ ...want[kind], finished: true });
    const all = Object.values(want);
    expect(answer.total).toEqual({ bytes: all.reduce((sum, use) => sum + use.bytes, 0), files: all.reduce((sum, use) => sum + use.files, 0), finished: true });
    expect(answer.disk!.total).toBeGreaterThan(0);
    expect(answer.disk!.free).toBeGreaterThan(0);
    expect(answer.disk!.free).toBeLessThanOrEqual(answer.disk!.total);
    // The leftover total is the fixture's, and a restart's five sweeps remove exactly those files.
    expect(answer.kinds.leftover_files.bytes).toBe(1000 + 2000 + 50 + 300 + 400 + 100 + 500 + 70 + 20);
    const leftovers = Object.entries(sizes).filter(([, [, kind]]) => kind === "leftover_files").map(([rel]) => rel);
    const before = filesNow();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await cleanTileScratch();
    await sweepTileArchives();
    await cleanIngestScratch();
    await cleanAbandonedDeletionCandidates();
    await sweepTableArtifacts();
    const after = filesNow();
    expect(before.filter(file => !after.includes(file)).sort()).toEqual(leftovers.sort());
    expect(after.filter(file => !before.includes(file))).toEqual([]);
  });

  it("answers in its closed shape, through its route, private and no-store, never naming two accounts' people, maps, datasets, ids, paths or files", async () => {
    const names: string[] = [data, root, SCRATCH];
    for (const [who, layer] of [["acct-ada-7c41", "1d0c5e8a-0b7e-4c3c-8f00-00000000ada1"], ["acct-ben-3e92", "1d0c5e8a-0b7e-4c3c-8f00-00000000be01"]]) {
      const scope = testAccountScope(p.db, who);
      const file = `tables/${who}-harbours.parquet`;
      table(scope, `${who}-dataset`, `${who}_harbours`, file);
      const mapId = tiledLayer(scope, layer, `${who} harbour map`);
      put(file, 123); put(`tiles/${layer}.pmtiles`, 45); put(`thumbnails/${mapId}.png`, 67);
      put(`tmp/${who}-upload.csv`, 8); put(`exports/${who}-project/archive.zip`, 9);
      names.push(who, `${who}@example.test`, `${who}-dataset`, `${who}_harbours`, `${who}-harbours.parquet`, file, layer, mapId, `${who} harbour map`, `${who}-upload`, `${who}-project`);
    }
    const response = await GET(read());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const answer = await response.json() as StorageRead;
    expect(Object.keys(answer).sort()).toEqual(["disk", "kinds", "total"]);
    expect(Object.keys(answer.kinds)).toEqual([...STORAGE_KINDS]);
    for (const use of [...Object.values(answer.kinds), answer.total]) expect(Object.keys(use).sort()).toEqual(["bytes", "files", "finished"]);
    expect(answer.kinds.tables).toEqual({ bytes: 246, files: 2, finished: true });
    const text = JSON.stringify(answer);
    for (const name of names) expect(text, `the answer holds ${name}`).not.toContain(name);
  });

  it("refuses a member, an anonymous caller and a cross-origin cookie, walking nothing; an admin's token and the same origin read", async () => {
    const memberToken = createApiToken(authenticateSession(p.member.secret, p.db)!, "Member", p.db).secret;
    const refused: [Record<string, string>, number][] = [
      [{}, 401],
      [{ cookie: `dezfil_session=${p.member.secret}`, origin: ORIGIN }, 403],
      [{ authorization: `Bearer ${memberToken}` }, 403],
      [{ cookie: `dezfil_session=${p.admin.secret}`, origin: "https://elsewhere.test" }, 403],
    ];
    for (const [headers, status] of refused) {
      const response = await GET(read(headers));
      expect(response.status, JSON.stringify(headers)).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
    }
    // The gate refuses the caller who is no admin before the route.
    for (const [headers, status] of refused.slice(0, 3)) expect(gateRequest(read(headers)).status).toBe(status);
    expect(watch.walks).toBe(0);
    const admitted: Record<string, string>[] = [{ authorization: `Bearer ${p.token.secret}` },
      { cookie: `dezfil_session=${p.admin.secret}`, origin: ORIGIN }, { cookie: `dezfil_session=${p.admin.secret}` }];
    for (const headers of admitted) {
      expect((await GET(read(headers))).status).toBe(200);
    }
    // A demoted admin is refused even a kept answer.
    p.db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run();
    expect((await GET(read())).status).toBe(403);
  });

  it("is a generated tool that asks first, refused by the SQL and workflow assistants", () => {
    const tool = buildTools().find(candidate => candidate.name === "read_storage")!;
    expect(tool).toBeDefined();
    expect(tool.confirm).toBe(true);
    expect(tool.effects.readOnly).toBe(true);
    expect(tool.effects.reachesOutside).toBeFalsy();
    expect(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})).toEqual([]);
    expect(admits("read_only", tool)).toBe(false);
    expect(admits("full", tool)).toBe(true);
  });
});

describe("one walk at a time", () => {
  it("makes one walk for five reads at once, none for a read within 30 seconds, and a new one after a cache's Clear, which it shows empty", async () => {
    put("cache/geocode/answer-1.json", 60);
    put("cache/isochrone/answer-2.json", 40);
    vi.useFakeTimers({ toFake: ["Date"] });
    const answers = await Promise.all(Array.from({ length: 5 }, () => readStorage(p.context, p.db)));
    expect(watch.walks).toBe(1);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0].kinds.service_caches).toEqual({ bytes: 100, files: 2, finished: true });
    vi.setSystemTime(Date.now() + 29_000);
    put("cache/geocode/answer-3.json", 10);
    expect(await readStorage(p.context, p.db)).toBe(answers[0]);
    expect(watch.walks).toBe(1);
    await clearServiceCaches(p.context, null, p.db);
    const cleared = await readStorage(p.context, p.db);
    expect(watch.walks).toBe(2);
    expect(cleared.kinds.service_caches).toEqual({ bytes: 0, files: 0, finished: true });
    // And a read 30 seconds after a walk walks again.
    vi.setSystemTime(Date.now() + 30_000);
    await readStorage(p.context, p.db);
    expect(watch.walks).toBe(3);
  });

  it("stops at 10 seconds, the reference read included, giving every kind as at least what it counted", async () => {
    put("tables/orphan.parquet", 1000);
    put("cache/geocode/answer-1.json", 60);
    vi.useFakeTimers({ toFake: ["Date"] });
    // The references themselves take the whole budget: nothing can be told.
    watch.afterReferences = () => vi.setSystemTime(Date.now() + 10_001);
    const held = await readStorage(p.context, p.db);
    for (const kind of STORAGE_KINDS) expect(held.kinds[kind], kind).toEqual({ bytes: 0, files: 0, finished: false });
    expect(held.total.finished).toBe(false);
    expect(watch.walks).toBe(0);
  });

  it("stops a walk held past 10 seconds, marking what the folders it had not finished may hold, and counting no more", async () => {
    put("tables/orphan.parquet", 1000);
    put("tables/another.parquet", 500);
    put("cache/geocode/answer-1.json", 60);
    put("tmp/upload.csv", 7);
    const full = await readStorage(p.context, p.db);
    forgetStorageRead();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The tables folder is read past the limit.
    watch.onRead = dir => { if (dir === path.join(data, "tables")) vi.setSystemTime(Date.now() + 10_001); };
    const held = await readStorage(p.context, p.db);
    expect(held.kinds.tables.finished).toBe(false);
    expect(held.kinds.leftover_files.finished).toBe(false);
    expect(held.kinds.leftover_files.bytes).toBeLessThan(full.kinds.leftover_files.bytes);
    for (const kind of STORAGE_KINDS) {
      expect(held.kinds[kind].bytes, kind).toBeLessThanOrEqual(full.kinds[kind].bytes);
      expect(held.kinds[kind].files, kind).toBeLessThanOrEqual(full.kinds[kind].files);
    }
    // The database's files sit at the top, seen before any folder.
    expect(held.kinds.metadata_database.finished).toBe(true);
    expect(held.total.finished).toBe(false);
  });
});
