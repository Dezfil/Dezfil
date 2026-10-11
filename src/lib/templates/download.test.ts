import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountScope } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import {
  ARCHIVE_SEEDS,
  FIXTURE_MEASUREMENTS,
  SEEDS,
  buildTemplate,
  writeShippedFolder,
  type BuiltTemplate,
  type TemplateFixtureOptions,
} from "../../../test-support/templates/builder";
import { startLoopbackCatalogue, writeFolderCatalogue, type LoopbackCatalogue } from "../../../test-support/templates/catalogue";
import { listTemplates, REFRESH_WINDOW_MS, refreshCatalogue, resetCatalogueForTests } from "./catalogue";
import { fetchTemplate, setDownloadSeamForTests } from "./download";
import { downloadedTemplatesDir, readInstalledVersion } from "./installed";
import { TemplateRefusal } from "./refusals";
import * as shipped from "./shipped";

/**
 * Downloading a listed version: once however many ask together, each
 * check before anything is installed, through the egress check with no
 * credential on any hop, its datasets read through the upload's reader and
 * its documents bound to its own data, and nothing left behind by a
 * refusal or a failure. A newer listed version installs beside the one in
 * use, which stays when the newer is refused; a version named is the one
 * acted on; and with the catalogue off nothing is sent.
 */

keepRequestsOnThisMachine();

let f: ReturnType<typeof instanceSettingsFixture>;
let catalogue: LoopbackCatalogue;
let dir: string;
let built: string;
let clock: number;
let A1: BuiltTemplate, A2: BuiltTemplate, W1: BuiltTemplate;

const MAP_ID = "harbour-stations";

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-download-"));
  A1 = await buildTemplate(path.join(built, "a1"), { id: MAP_ID, version: 1 });
  A2 = await buildTemplate(path.join(built, "a2"), { id: MAP_ID, version: 2, title: "Harbour stations, updated" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations", version: 1 });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-download-run-"));
  vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), []));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "localhost,127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32));
  resetSecretKeyCache();
  resetCatalogueForTests();
  clock = Date.now();
  catalogue = await startLoopbackCatalogue();
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl);
});
afterEach(async () => {
  setDownloadSeamForTests(null);
  await catalogue.close();
  resetCatalogueForTests();
  resetQueryInstance();
  f.close();
  resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

let fixtures = 0;
const build = (options: TemplateFixtureOptions) => buildTemplate(path.join(dir, `built-${fixtures++}`), options);
/** Read the catalogue again, past the ten-minute window. */
const refresh = () => {
  clock += REFRESH_WINDOW_MS + 1;
  return refreshCatalogue(f.db, { now: clock });
};
const fetchAs = (id: string, version: number | null = null) => fetchTemplate(testAccountScope(f.db, "member"), id, version, f.db);
const archiveRequests = () => catalogue.requests.filter((r) => r.path.startsWith("/archives/") || r.path.startsWith("/assets/"));
const versionFolder = (id: string, version: number) => path.join(downloadedTemplatesDir(), id, String(version));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Every file under the data folder with its checksum: what a refusal must
 * leave as it found. Folders count for nothing (the engine makes its own
 * on start), the metadata store is in memory. */
async function dataFolder(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(dataDir(), { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dataDir(), file)] = sha(await readFile(file));
  }
  return out;
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TemplateRefusal || error instanceof ApiError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("two fetches of one version", () => {
  it("download it once, held together before the one request, size and checksum checked; a fetch after sends nothing", async () => {
    await catalogue.publish([A1]);
    await refresh();
    let entered = 0;
    let turns = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let turned!: () => void;
    const atTurn = new Promise<void>((resolve) => { turned = resolve; });
    setDownloadSeamForTests({
      entered: () => { entered += 1; },
      transfer: async () => { turns += 1; turned(); await held; },
    });

    const first = fetchAs(MAP_ID);
    const second = fetchAs(MAP_ID);
    await atTurn;
    await vi.waitFor(() => expect(entered).toBe(2));
    expect(archiveRequests()).toEqual([]);
    release();
    const answers = await Promise.all([first, second]);

    expect(answers).toEqual([
      { id: MAP_ID, version: 1, size: A1.size, downloaded: true },
      { id: MAP_ID, version: 1, size: A1.size, downloaded: true },
    ]);
    expect(turns).toBe(1);
    expect(archiveRequests()).toHaveLength(1);
    const installed = await readInstalledVersion(versionFolder(MAP_ID, 1));
    expect(installed.record).toMatchObject({
      id: MAP_ID, version: 1, archive: { sha256: A1.sha256, size: A1.size }, origin: { kind: "catalogue", origin: catalogue.origin },
    });
    expect(installed.record.measured).toEqual({
      "datasets/stations.parquet": { rowCount: 6, geometryColumn: "geom", geometryType: "POINT", crsAssumed: false },
      "datasets/districts.parquet": { rowCount: 2, geometryColumn: "geom", geometryType: "POLYGON", crsAssumed: false },
    });
    // Nothing beside the installed version: the scratch and the second
    // stage's artifacts are gone.
    expect(Object.keys(await dataFolder()).filter((file) => !file.startsWith(`templates${path.sep}`))).toEqual([]);

    const listed = await listTemplates(f.db);
    expect(listed.templates).toEqual([expect.objectContaining({ id: MAP_ID, installed: 1, listed: 1, present: true, size: A1.size })]);
    expect(await fetchAs(MAP_ID)).toEqual({ id: MAP_ID, version: 1, size: A1.size, downloaded: false });
    expect(archiveRequests()).toHaveLength(1);
    expect(entered).toBe(2);
  });

  it("installs a workflow example with its bundled results, read through the upload's reader", async () => {
    await catalogue.publish([W1]);
    await refresh();
    expect(await fetchAs("busy-stations")).toMatchObject({ version: 1, downloaded: true });
    const installed = await readInstalledVersion(versionFolder("busy-stations", 1));
    expect(Object.keys(installed.record.measured).sort()).toEqual([
      "datasets/districts.parquet", "datasets/stations.parquet", "results/step-busy.parquet", "results/step-rings.parquet",
    ]);
    expect(installed.record.measured["results/step-rings.parquet"]).toMatchObject({ rowCount: 4, geometryType: "POLYGON" });
    // The fixture's installed form records what the reader measures, so a
    // version installed by hand reads as one installed by this road.
    expect(installed.record.measured).toEqual(FIXTURE_MEASUREMENTS);
  });

  it("from the catalogue's folder, installs as a download does, its origin the folder", async () => {
    const folder = path.join(dir, "catalogue");
    await writeFolderCatalogue(folder, [A1]);
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", folder);
    await refresh();
    expect(await fetchAs(MAP_ID)).toEqual({ id: MAP_ID, version: 1, size: A1.size, downloaded: true });
    expect((await readInstalledVersion(versionFolder(MAP_ID, 1))).record.origin).toEqual({ kind: "folder" });
    expect(catalogue.requests).toEqual([]);
  });
});

describe("the hops", () => {
  it("a release-style address redirecting to a second host downloads, and no request carries a credential", async () => {
    await catalogue.publish([A1], { releaseStyle: true });
    await refresh();
    expect(await fetchAs(MAP_ID)).toMatchObject({ downloaded: true });
    expect(catalogue.requestsFor(`/archives/${MAP_ID}-1.zip`, "primary")).toHaveLength(1);
    expect(catalogue.requestsFor(`/assets/${MAP_ID}-1.zip`, "second")).toHaveLength(1);
    expect(catalogue.requests.length).toBeGreaterThan(2);
    for (const request of catalogue.requests) {
      expect(request.headers.authorization, `${request.host} ${request.path}`).toBeUndefined();
      expect(request.headers.cookie, `${request.host} ${request.path}`).toBeUndefined();
      expect(request.headers["proxy-authorization"], `${request.host} ${request.path}`).toBeUndefined();
    }
  });

  it("a redirect into blocked space is refused before it is reached, leaving nothing", async () => {
    await catalogue.publish([A1]);
    await refresh();
    catalogue.redirect(`/archives/${MAP_ID}-1.zip`, "http://10.20.30.40/archive.zip");
    const before = await dataFolder();
    expect(await refusal(fetchAs(MAP_ID))).toBe("egress_blocked");
    expect(await dataFolder()).toEqual(before);
  });

  it("a redirect naming a user name and password is not followed", async () => {
    await catalogue.publish([A1]);
    await refresh();
    catalogue.redirect(`/archives/${MAP_ID}-1.zip`, `http://seeded-user:seeded-pass@127.0.0.1:${new URL(catalogue.secondOrigin).port}/assets/a.zip`);
    const before = await dataFolder();
    expect(await refusal(fetchAs(MAP_ID))).toBe("remote_fetch_failed");
    expect(catalogue.requests.filter((r) => r.host === "second")).toEqual([]);
    expect(await dataFolder()).toEqual(before);
  });
});

describe("a refused download's words", () => {
  it("name neither the catalogue's address nor anything in it", async () => {
    const secret = "SEEDED-KEY-0001-TEMPLATES";
    const index = await catalogue.publish([A1]);
    catalogue.serve(`/${secret}/index.json`, JSON.stringify(index), { type: "application/json" });
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", `${catalogue.origin}/${secret}/index.json?key=${secret}`);
    await refresh();
    const words = async () => {
      const error = await fetchAs(MAP_ID).catch((e: unknown) => e);
      if (!(error instanceof ApiError)) throw error;
      expect(JSON.stringify({ code: error.code, message: error.message })).not.toContain(secret);
      return error.code;
    };
    // Not served under that path: the catalogue answers a status.
    expect(await words()).toBe("remote_fetch_failed");
    // Redirected to a port nothing answers on: the transport's failure.
    const closed = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    });
    catalogue.redirect(`/${secret}/archives/${MAP_ID}-1.zip`, `http://127.0.0.1:${closed}/${secret}/archive.zip`);
    expect(await words()).toBe("remote_fetch_failed");
    // Past the time bound.
    vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "0.2");
    catalogue.stall(`/${secret}/archives/${MAP_ID}-1.zip`);
    expect(await words()).toBe("remote_timeout");
    expect(await readdir(downloadedTemplatesDir()).catch(() => [])).toEqual([]);
  });
});

describe("a newer version listed", () => {
  it("installs beside the one in use, which stays as it was; a refused newer one leaves both as they were", async () => {
    await catalogue.publish([A1]);
    await refresh();
    await fetchAs(MAP_ID);
    const v1 = await dataFolder();

    await catalogue.publish([A2]);
    await refresh();
    expect((await listTemplates(f.db)).templates[0]).toMatchObject({ version: 2, installed: 1, listed: 2, present: false });
    expect(await fetchAs(MAP_ID)).toEqual({ id: MAP_ID, version: 2, size: A2.size, downloaded: true });
    const both = await dataFolder();
    for (const [file, digest] of Object.entries(v1)) expect(both[file], file).toBe(digest);
    expect((await readInstalledVersion(versionFolder(MAP_ID, 1))).admitted.facts.version).toBe(1);
    expect((await readInstalledVersion(versionFolder(MAP_ID, 2))).admitted.facts.title).toBe("Harbour stations, updated");
    expect((await listTemplates(f.db)).templates[0]).toMatchObject({ version: 2, installed: 2, listed: 2, present: true });

    const invalid = await build({ id: MAP_ID, version: 3, edit: SEEDS.layerReferenceOutside });
    await catalogue.publish([invalid]);
    await refresh();
    expect(await refusal(fetchAs(MAP_ID))).toBe("template_reference_outside");
    expect(await dataFolder()).toEqual(both);
    expect((await readInstalledVersion(versionFolder(MAP_ID, 2))).admitted.facts.version).toBe(2);
    expect((await listTemplates(f.db)).templates[0]).toMatchObject({ version: 3, installed: 2, listed: 3, present: false });
  });
});

describe("a version named", () => {
  it("is the one acted on, and no other", async () => {
    await catalogue.publish([A1]);
    await refresh();
    const before = catalogue.requests.length;
    expect(await refusal(fetchAs(MAP_ID, 2))).toBe("template_not_listed");
    expect(catalogue.requests).toHaveLength(before);

    expect(await fetchAs(MAP_ID, 1)).toMatchObject({ version: 1, downloaded: true });
    await catalogue.publish([A2]);
    await refresh();
    expect(await fetchAs(MAP_ID, 1)).toEqual({ id: MAP_ID, version: 1, size: A1.size, downloaded: false });
    expect(archiveRequests()).toHaveLength(1);
    expect(await fetchAs(MAP_ID, 2)).toMatchObject({ version: 2, downloaded: true });
    expect(archiveRequests().map((r) => r.path)).toEqual([`/archives/${MAP_ID}-1.zip`, `/archives/${MAP_ID}-2.zip`]);
  });

  it("no longer listed and not installed, is refused, never the newer one in its place", async () => {
    await catalogue.publish([A1]);
    await refresh();
    await catalogue.publish([A2]);
    await refresh();
    expect(await refusal(fetchAs(MAP_ID, 1))).toBe("template_not_listed");
    expect(archiveRequests()).toEqual([]);
    expect(await refusal(fetchAs("no-such-template"))).toBe("template_not_listed");
  });
});

describe("each refusal", () => {
  const garbage = Buffer.from("PK seeded bytes that are no archive");
  const cases: [string, () => Promise<BuiltTemplate>, Parameters<LoopbackCatalogue["publish"]>[1], string, (() => void)?][] = [
    ["an archive over the size the index declares", async () => A2, { edit: (i) => { i.templates[0].size = A2.size - 1; } }, "template_archive_too_large"],
    ["an archive under the size the index declares", async () => A2, { edit: (i) => { i.templates[0].size = A2.size + 1; } }, "template_checksum_mismatch"],
    ["a checksum other than the index's", async () => A2, { edit: (i) => { i.templates[0].sha256 = "0".repeat(64); } }, "template_checksum_mismatch"],
    ["an archive that is not one", async () => A2,
      { edit: (i) => { i.templates[0].size = garbage.length; i.templates[0].sha256 = sha(garbage); } }, "template_malformed",
      () => catalogue.serve(`/archives/${MAP_ID}-2.zip`, garbage)],
    ["a member escaping its folder", () => build({ id: MAP_ID, version: 2, zip: ARCHIVE_SEEDS.escapingEntry }), {}, "template_entry_escapes"],
    ["a document failing the first stage", () => build({ id: MAP_ID, version: 2, edit: SEEDS.invalidStyle }), {}, "template_invalid"],
    ["a dataset the upload's reader cannot read", () => build({ id: MAP_ID, version: 2, edit: SEEDS.unreadableDataset }), {}, "template_malformed"],
    ["a widget reading a column its layer does not have", () => build({ id: MAP_ID, version: 2, edit: SEEDS.widgetColumnMissing }), {}, "template_invalid"],
    ["a layer naming a dataset outside the template", () => build({ id: MAP_ID, version: 2, edit: SEEDS.layerReferenceOutside }), {}, "template_reference_outside"],
    ["an archive holding another version than its entry", () => build({ id: MAP_ID, version: 3 }),
      { edit: (i) => { i.templates[0].facts.version = 2; } }, "template_invalid"],
    ["an archive the catalogue does not serve", async () => A2, {}, "remote_fetch_failed",
      () => catalogue.status(`/archives/${MAP_ID}-2.zip`, 404)],
  ];

  it.each(cases)("%s is coded, leaving the data folder, the card and the installed version as they were", async (_what, template, publish, code, after) => {
    await catalogue.publish([A1]);
    await refresh();
    await fetchAs(MAP_ID);
    await catalogue.publish([await template()], publish);
    after?.();
    await refresh();
    const card = (await listTemplates(f.db)).templates[0];
    expect(card).toMatchObject({ version: 2, installed: 1, listed: 2, present: false });
    const before = await dataFolder();

    expect(await refusal(fetchAs(MAP_ID))).toBe(code);

    expect(await dataFolder()).toEqual(before);
    expect((await listTemplates(f.db)).templates[0]).toEqual(card);
    expect((await readInstalledVersion(versionFolder(MAP_ID, 1))).admitted.facts.version).toBe(1);
    expect(await fetchAs(MAP_ID, 1)).toMatchObject({ version: 1, downloaded: false });
  });

  it("a transfer past the link import's time bound is refused, leaving no file", async () => {
    vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "0.2");
    await catalogue.publish([A1]);
    await refresh();
    catalogue.stall(`/archives/${MAP_ID}-1.zip`);
    const before = await dataFolder();
    expect(await refusal(fetchAs(MAP_ID))).toBe("remote_timeout");
    expect(await dataFolder()).toEqual(before);
    expect(await readdir(downloadedTemplatesDir()).catch(() => [])).toEqual([]);
  });

  it("a stale folder where the version installs, with no record, is replaced by the version once it passes", async () => {
    await catalogue.publish([A1]);
    await refresh();
    await mkdir(versionFolder(MAP_ID, 1), { recursive: true });
    await writeFile(path.join(versionFolder(MAP_ID, 1), "left-behind.txt"), "seeded");
    expect(await fetchAs(MAP_ID)).toMatchObject({ downloaded: true });
    expect(await readdir(versionFolder(MAP_ID, 1))).not.toContain("left-behind.txt");
    expect((await readInstalledVersion(versionFolder(MAP_ID, 1))).record.id).toBe(MAP_ID);
  });
});

describe("a template's data and nothing else", () => {
  async function personDataset(name: string): Promise<void> {
    const file = `tables/${randomUUID()}.parquet`;
    await mkdir(path.join(dataDir(), "tables"), { recursive: true });
    await writeFile(path.join(dataDir(), file), A1.files.binaries.get("datasets/stations.parquet")!);
    insertTable(testAccountScope(f.db, "member"), {
      id: randomUUID(), name, sourceFilename: `${name}.parquet`, format: "geoparquet", file,
      geometryColumn: "geom", geometryType: "POINT", crsAssumed: false, headerSuspect: false, rowCount: 6,
      createdAt: new Date().toISOString(), source: "upload", sourceParams: null, importedAt: null,
    } as DataTable, f.db);
  }

  it("a layer naming the caller's own dataset is refused at install", async () => {
    await personDataset("roads");
    await catalogue.publish([await build({ id: "outside-roads", edit: SEEDS.layerReferenceOutside })]);
    await refresh();
    const before = await dataFolder();
    expect(await refusal(fetchAs("outside-roads"))).toBe("template_reference_outside");
    expect(await dataFolder()).toEqual(before);
  });

  it("a step reading the caller's own dataset is refused at install", async () => {
    await personDataset("roads");
    await catalogue.publish([await build({ kind: "workflow", id: "outside-step", edit: SEEDS.stepReferenceOutside })]);
    await refresh();
    expect(await refusal(fetchAs("outside-step"))).toBe("template_reference_outside");
  });

  it("a layer naming another template's result is refused at install, that template installed", async () => {
    const borrowing = await build({ id: "borrowing", edit: (files) => {
      (files.documents.get("maps/map.json")!.layers as Record<string, unknown>[])[0].sql = "SELECT * FROM busy_stations";
    } });
    await catalogue.publish([W1, borrowing]);
    await refresh();
    await fetchAs("busy-stations");
    expect(await refusal(fetchAs("borrowing"))).toBe("template_reference_outside");
    expect(await readdir(downloadedTemplatesDir())).toEqual(["busy-stations"]);
  });
});

describe("with the catalogue off", () => {
  const off = () => writeStoredSettings({ "templates.catalogue": false }, f.db);

  it("a fetch of an absent version answers the coded reason and sends nothing; an installed one still answers", async () => {
    await catalogue.publish([A1, W1]);
    await refresh();
    await fetchAs("busy-stations");
    const sent = catalogue.requests.length;
    off();
    expect(await refusal(fetchAs(MAP_ID))).toBe("templates_catalogue_off");
    expect(await refusal(fetchAs(MAP_ID, 1))).toBe("templates_catalogue_off");
    expect(await fetchAs("busy-stations")).toMatchObject({ version: 1, downloaded: false });
    expect(catalogue.requests).toHaveLength(sent);
  });

  it("a download waiting its turn when the catalogue is turned off sends nothing", async () => {
    await catalogue.publish([A1]);
    await refresh();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let turned!: () => void;
    const atTurn = new Promise<void>((resolve) => { turned = resolve; });
    setDownloadSeamForTests({ transfer: async () => { turned(); await held; } });
    const waiting = fetchAs(MAP_ID);
    await atTurn;
    off();
    release();
    expect(await refusal(waiting)).toBe("templates_catalogue_off");
    expect(archiveRequests()).toEqual([]);
    expect(await readdir(downloadedTemplatesDir()).catch(() => [])).toEqual([]);
  });
});
