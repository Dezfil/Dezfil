import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GET } from "@/app/api/instance/storage/route";
import { admits } from "@/lib/assistant/policy";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { cleanAbandonedDeletionCandidates } from "@/lib/auth/account-deletion-candidate-recovery";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { delegateCredential } from "@/lib/auth/delegation";
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
import { forgetStorageRead, readStorage, STORAGE_WALK_MS } from "./storage";

/**
 * The storage read: what the data folder holds, by kind, from its names and
 * sizes and which files the metadata references, never a name, an owner or
 * a path. Leftover files are what the next restart's sweeps remove, held
 * here against the sweeps themselves. One walk at a time, its answer given
 * again for 30 seconds unless a cache's Clear came between, and a walk
 * stopped at 10 seconds, its reference read, every filesystem call and the
 * disk's statistics included, gives what it had not finished as at least.
 * Admins only; a link counts nothing.
 */

keepRequestsOnThisMachine();

/** Reads of the data folder's top, one per walk, and what a test does at a
 * read or after the references; `hold` answers a filesystem call in the
 * call's place, as one that does not come back. */
type Held = (call: "readdir" | "lstat" | "statfs", target: string) => Promise<unknown> | undefined;
const watch = vi.hoisted(() => ({ root: "", walks: 0, calls: 0, onRead: null as null | ((dir: string) => void), afterReferences: null as null | (() => void), hold: null as null | Held }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = ((dir: unknown, ...rest: unknown[]) => {
    watch.calls += 1;
    if (String(dir) === watch.root) watch.walks += 1;
    watch.onRead?.(String(dir));
    return watch.hold?.("readdir", String(dir)) ?? (real.readdir as (...given: unknown[]) => unknown)(dir, ...rest);
  }) as typeof real.readdir;
  const lstat = ((file: unknown, ...rest: unknown[]) => {
    watch.calls += 1;
    return watch.hold?.("lstat", String(file)) ?? (real.lstat as (...given: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.lstat;
  const statfs = ((folder: unknown, ...rest: unknown[]) => {
    watch.calls += 1;
    return watch.hold?.("statfs", String(folder)) ?? (real.statfs as (...given: unknown[]) => unknown)(folder, ...rest);
  }) as typeof real.statfs;
  return { ...real, readdir, lstat, statfs, default: { ...real, readdir, lstat, statfs } };
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
  Object.assign(watch, { root: data, walks: 0, calls: 0, onRead: null, afterReferences: null, hold: null });
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
/** A read, by default as this instance's own page makes it: the admin's
 * cookie on a same-origin fetch, which carries no Origin. */
const read = (headers: Record<string, string> = { cookie: `dezfil_session=${p.admin.secret}`, "sec-fetch-site": "same-origin" }) =>
  socketRequest(new Request(`${ORIGIN}/api/instance/storage`, { headers }));

const L_KEPT = "0b6f3c1e-7d1a-4a52-9c1e-000000000001", L_GONE = "0b6f3c1e-7d1a-4a52-9c1e-000000000002";
const STAGED = "exports/0b6f3c1e-7d1a-4a52-9c1e-0000000000e1.zip";

/** The fixture folder: each kind, an identical pair that differs only in
 * whether the metadata references it, and one of each leftover place. */
function fixtureFolder() {
  const scope = testAccountScope(p.db, "admin");
  table(scope, "table-kept", "kept", "tables/kept.parquet");
  const mapId = tiledLayer(scope, L_KEPT, "Kept map");
  registerAccountFile("admin", "tables/kept.parquet");
  // Staged exports, registered as the export road registers them, before
  // their bytes: the restart's recovery removes each with its record.
  registerAccountFile("admin", STAGED);
  registerAccountFile("admin", "exports/project-0003/archive.zip");
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
    [STAGED]: [600, "leftover_files"],
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
  for (const { size, kind } of ownershipRecords()) { want[kind].bytes += size; want[kind].files += 1; }
  return want;
}

/** The ownership records, each as the restart treats it: a staged export's
 * goes with its file, the kept table's is the server's own. */
function ownershipRecords(): { rel: string; size: number; kind: StorageKind }[] {
  return readdirSync(path.join(data, "file-owners")).map(name => {
    const rel = path.join("file-owners", name);
    const record = JSON.parse(readFileSync(path.join(data, rel), "utf8")) as { file: string };
    return { rel, size: lstatSync(path.join(data, rel)).size, kind: record.file.startsWith("exports/") ? "leftover_files" : "other" };
  });
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
    // The leftover total is the fixture's with the two staged exports' records,
    // and a restart's five sweeps remove exactly those files.
    const records = ownershipRecords().filter(record => record.kind === "leftover_files");
    expect(records).toHaveLength(2);
    expect(answer.kinds.leftover_files.bytes).toBe(1000 + 2000 + 50 + 300 + 400 + 100 + 500 + 600 + 70 + 20 + records.reduce((sum, record) => sum + record.size, 0));
    const leftovers = [...Object.entries(sizes).filter(([, [, kind]]) => kind === "leftover_files").map(([rel]) => rel), ...records.map(record => record.rel)];
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

  it("refuses a member, an anonymous caller and an admin's cookie without same-origin evidence or with another origin's, a cross-site navigation's too, walking nothing; an admin's token, the assistant's delegation and the instance's own pages read", async () => {
    const memberToken = createApiToken(authenticateSession(p.member.secret, p.db)!, "Member", p.db).secret;
    const cookie = `dezfil_session=${p.admin.secret}`;
    const refused: [Record<string, string>, number][] = [
      [{}, 401],
      [{ cookie: `dezfil_session=${p.member.secret}`, origin: ORIGIN }, 403],
      [{ authorization: `Bearer ${memberToken}` }, 403],
      [{ cookie, origin: "https://elsewhere.test" }, 403],
      // A link or a form on another site: the Lax cookie rides along, no Origin does.
      [{ cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, 403],
      [{ cookie, "sec-fetch-site": "same-site" }, 403],
      [{ cookie, origin: "https://elsewhere.test", "sec-fetch-site": "same-origin" }, 403],
      // The app's own header beside a word of another origin: the other origin wins.
      [{ cookie, "x-dezfil-account": "admin", origin: "https://elsewhere.test" }, 403],
      [{ cookie, "x-dezfil-account": "admin", "sec-fetch-site": "cross-site" }, 403],
      // Neither an Origin, the browser's own word that the page is this
      // instance's, nor the header this instance's own pages add.
      [{ cookie }, 403],
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
    const admitted: Record<string, string>[] = [
      { authorization: `Bearer ${p.token.secret}`, "sec-fetch-site": "cross-site" },
      { authorization: `Bearer ${delegateCredential(p.context, p.db)}`, "sec-fetch-site": "cross-site" },
      { cookie, origin: ORIGIN },
      // This instance's own page reading it: a same-origin fetch carries no Origin.
      { cookie, "sec-fetch-site": "same-origin" },
      // The same page on a plain-HTTP address off localhost: the browser sends
      // no fetch metadata there, only the header the app's fetch adds.
      { cookie, "x-dezfil-account": "admin" },
    ];
    for (const headers of admitted) {
      expect((await GET(read(headers))).status, JSON.stringify(headers)).toBe(200);
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

  it("never gives a walk begun before a cache's Clear to a read after it: such reads wait for it and join one fresh walk", async () => {
    put("cache/geocode/answer-1.json", 60);
    put("cache/isochrone/answer-2.json", 40);
    // The first walk counts everything, then waits on the disk's statistics.
    const held = Promise.withResolvers<never>();
    let asked = false;
    watch.hold = call => {
      if (call !== "statfs" || asked) return undefined;
      asked = true;
      return held.promise;
    };
    const before = readStorage(p.context, p.db);
    for (let rest = 0, last = -1; rest < 3; rest = watch.calls === last ? rest + 1 : 0) { last = watch.calls; await sleep(20); }
    expect(asked).toBe(true);
    await clearServiceCaches(p.context, null, p.db);
    const after = [readStorage(p.context, p.db), readStorage(p.context, p.db)];
    held.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
    expect((await before).kinds.service_caches).toEqual({ bytes: 100, files: 2, finished: true });
    const [first, second] = await Promise.all(after);
    expect(first.kinds.service_caches, "a read after the Clear was given the walk begun before it").toEqual({ bytes: 0, files: 0, finished: true });
    expect(second).toBe(first);
    expect(watch.walks).toBe(2);
  });

  it("answers a read after a cache's Clear within 10 seconds of its asking, the Clear ending the walk under way, whose readers get what it had counted", async () => {
    put("tables/orphan.parquet", 1000);
    put("cache/geocode/answer-1.json", 60);
    // Every walk is held at the tables folder's read.
    const held = Promise.withResolvers<never>();
    watch.hold = (call, at) => (call === "readdir" && at === path.join(data, "tables") ? held.promise : undefined);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      let beforeAt: number | null = null;
      const before = readStorage(p.context, p.db).finally(() => { beforeAt = Date.now(); });
      for (let rest = 0, last = -1; rest < 3; rest = watch.calls === last ? rest + 1 : 0) { last = watch.calls; await sleep(20); }
      expect(watch.walks).toBe(1);
      // Nine seconds into that walk, a cache is cleared and a read is asked.
      await vi.advanceTimersByTimeAsync(9_000);
      await clearServiceCaches(p.context, null, p.db);
      const asked = Date.now();
      let answeredAt: number | null = null;
      const after = readStorage(p.context, p.db).finally(() => { answeredAt = Date.now(); });
      for (let second = 0; second < 25 && answeredAt === null; second += 1) await vi.advanceTimersByTimeAsync(1_000);
      expect(answeredAt, "the read after the Clear was not answered").not.toBeNull();
      expect(answeredAt! - asked, "the read after the Clear answered past its 10 seconds").toBeLessThanOrEqual(STORAGE_WALK_MS);
      // Its own walk, held too, gives what it had not finished as at least.
      const fresh = await after;
      expect(fresh.kinds.tables.finished).toBe(false);
      expect(fresh.total.finished).toBe(false);
      expect(watch.walks).toBe(2);
      // The read joined before the Clear had its answer at the Clear: what its
      // walk had counted, every kind it had not finished as at least.
      const stale = await before;
      expect(beforeAt! - asked, "the walk under way ran on past the Clear").toBeLessThanOrEqual(0);
      expect(stale.kinds.tables.finished).toBe(false);
      expect(stale.total.finished).toBe(false);
      expect(stale.kinds.metadata_database.finished).toBe(true);
    } finally {
      held.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
    }
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

  it("cuts a reference read longer than 10 seconds between its slices, giving every kind as at least what it counted", async () => {
    put("tables/orphan.parquet", 1000);
    const scope = testAccountScope(p.db, "admin");
    p.db.transaction(() => { for (let i = 0; i < 3000; i += 1) table(scope, `t-${i}`, `t_${i}`, `tables/t-${i}.parquet`); })();
    vi.useFakeTimers({ toFake: ["Date"] });
    // Each table the reference read returns takes it 10 ms: all of them, 30 seconds.
    const prepare = p.db.prepare.bind(p.db);
    const slow = vi.spyOn(p.db, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (/FROM data_tables/.test(sql)) {
        const all = statement.all.bind(statement) as (...args: unknown[]) => unknown[];
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args);
          vi.setSystemTime(Date.now() + rows.length * 10);
          return rows;
        }) as typeof statement.all;
      }
      return statement;
    }) as typeof p.db.prepare);
    try {
      const started = Date.now();
      const answer = await readStorage(p.context, p.db);
      expect(Date.now() - started, "the read ran on past its 10 seconds").toBeLessThanOrEqual(STORAGE_WALK_MS + 2_000);
      for (const kind of STORAGE_KINDS) expect(answer.kinds[kind], kind).toEqual({ bytes: 0, files: 0, finished: false });
      expect(answer.total.finished).toBe(false);
      expect(watch.walks).toBe(0);
    } finally {
      slow.mockRestore();
    }
  });

  it.each([
    ["a folder's read", "readdir", () => path.join(data, "tables")],
    ["a file's look", "lstat", () => path.join(data, "tables", "orphan.parquet")],
    ["the disk's statistics", "statfs", () => data],
  ] as const)("answers at 10 seconds while %s is held, ending the walk and owning the held call", async (_what, call, target) => {
    put("tables/orphan.parquet", 1000);
    put("cache/geocode/answer-1.json", 60);
    const held = Promise.withResolvers<never>();
    let asked = false;
    watch.hold = (made, at) => {
      if (made !== call || at !== target()) return undefined;
      asked = true;
      return held.promise;
    };
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reading = readStorage(p.context, p.db);
      for (let i = 0; i < 500 && !asked; i += 1) await sleep(10);
      expect(asked).toBe(true);
      // Whatever is not held runs to its end first: the calls come to rest.
      for (let rest = 0, last = -1; rest < 3; rest = watch.calls === last ? rest + 1 : 0) { last = watch.calls; await sleep(20); }
      await vi.advanceTimersByTimeAsync(STORAGE_WALK_MS + 1);
      const answer = await Promise.race([reading, sleep(2_000).then(() => "still pending" as const)]);
      expect(answer, "the read still waits on the held call past its 10 seconds").not.toBe("still pending");
      const read = answer as StorageRead;
      if (call === "statfs") {
        expect(read.disk).toBeNull();
        expect(read.total.finished).toBe(true);
      } else {
        expect(read.kinds.tables.finished).toBe(false);
        expect(read.kinds.leftover_files.finished).toBe(false);
        expect(read.total.finished).toBe(false);
      }
      // The held call comes back late: the walk has ended and makes no more calls.
      const calls = watch.calls;
      held.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
      await sleep(50);
      expect(watch.calls).toBe(calls);
    } finally {
      held.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
    }
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
