import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { egressBlockedError } from "@/lib/net/egress";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testService } from "@/lib/settings/service-tests";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { buildTemplate, installFixture, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import { startLoopbackCatalogue, writeFolderCatalogue, type LoopbackCatalogue } from "../../../test-support/templates/catalogue";
import type { TemplateCard } from "./card";
import {
  listTemplates,
  readTemplate,
  REFRESH_WINDOW_MS,
  refreshCatalogue,
  resetCatalogueForTests,
  templatePicture,
} from "./catalogue";
import { CATALOGUE_INDEX_FILE, TEMPLATE_FORMAT_VERSION, TEMPLATE_INDEX_MAX_BYTES, TEMPLATE_PICTURE_MAX_BYTES, type CatalogueIndex } from "./format";
import * as shipped from "./shipped";

/**
 * The template list and the catalogue read behind it. The list answers from
 * disk and from the last list this process read, and sends nothing; a
 * refresh reads the index and the pictures through the egress check at most
 * once in ten minutes, joins a read under way, keeps the previous list until
 * a new one is whole, and discards a read that finishes after the address or
 * the switch changed. Each state of the catalogue comes from its own
 * fixture, with the shipped and downloaded templates listed under every one;
 * each refusal of the index is coded and refuses it whole; a picture past
 * its bound is refused alone, and the pictures stop at their total. Off,
 * nothing is sent. The Test reads the index alone.
 */

keepRequestsOnThisMachine();

let dir: string;
let f: ReturnType<typeof instanceSettingsFixture>;
let catalogue: LoopbackCatalogue;
/** Built once: a map template, a workflow example, a third map, and newer
 * versions of the first two. */
let A1: BuiltTemplate, A2: BuiltTemplate, B1: BuiltTemplate, B2: BuiltTemplate, C1: BuiltTemplate;
let built: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-list-"));
  A1 = await buildTemplate(path.join(built, "a1"), { id: "harbour-stations", version: 1 });
  A2 = await buildTemplate(path.join(built, "a2"), { id: "harbour-stations", version: 2, title: "Harbour stations, renewed" });
  B1 = await buildTemplate(path.join(built, "b1"), { kind: "workflow", id: "busy-stations", version: 1 });
  B2 = await buildTemplate(path.join(built, "b2"), { kind: "workflow", id: "busy-stations", version: 2, title: "Busy stations, renewed" });
  C1 = await buildTemplate(path.join(built, "c1"), { id: "quiet-park", version: 1, title: "Quiet park" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

let shippedDir: string;
beforeEach(async () => {
  f = instanceSettingsFixture();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-list-run-"));
  shippedDir = path.join(dir, "shipped");
  await writeShippedFolder(shippedDir, []);
  vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(shippedDir);
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "localhost,127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32));
  resetSecretKeyCache();
  resetCatalogueForTests();
  catalogue = await startLoopbackCatalogue();
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl);
});
afterEach(async () => {
  await catalogue.close();
  resetCatalogueForTests();
  f.close();
  resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

/** Ship these templates in the image's folder. */
const ship = (...templates: BuiltTemplate[]) => writeShippedFolder(shippedDir, templates);
/** Install this version as a download, under the data folder. */
const download = (t: BuiltTemplate) =>
  installFixture(t, path.join(f.dir, "templates", t.facts.id, String(t.facts.version)), { kind: "catalogue", origin: catalogue.origin });
const ids = (cards: TemplateCard[]) => cards.map((c) => `${c.id}@${c.version}`);
const picturePaths = () => catalogue.requests.filter((r) => r.path.startsWith("/pictures/")).map((r) => r.path);
const indexRequests = () => catalogue.requestsFor(`/${CATALOGUE_INDEX_FILE}`).length;
const switchOff = () => writeStoredSettings({ "templates.catalogue": false }, f.db);

describe("the list", () => {
  it("answers the shipped and downloaded templates from disk and sends nothing before a refresh", async () => {
    await ship(C1);
    await download(B1);
    await catalogue.publish([A1]);
    const list = await listTemplates(f.db);
    expect(ids(list.templates)).toEqual(["quiet-park@1", "busy-stations@1"]);
    expect(list.templates[0]).toEqual({
      id: "quiet-park", kind: "map", version: 1, title: "Quiet park", question: C1.facts.question, place: C1.facts.place,
      tags: C1.facts.tags, dataDate: C1.facts.dataDate, sources: C1.facts.sources, origin: "shipped", installed: 1, listed: null,
      present: true, size: C1.size, picture: "kept",
    });
    expect(list.templates[1]).toMatchObject({ origin: "catalogue", installed: 1, listed: null, present: true, size: B1.size, kind: "workflow" });
    expect(list.catalogue).toEqual({ state: "not_read", host: catalogue.origin, folder: false, readAt: null, reason: null, status: null });
    expect(catalogue.requests).toEqual([]);
  });

  it("draws the catalogue's entries after the shipped ones, in the index's order, then the downloads it does not name", async () => {
    await ship(C1);
    await download(B1);
    await catalogue.publish([A1]);
    const list = await refreshCatalogue(f.db);
    expect(ids(list.templates)).toEqual(["quiet-park@1", "harbour-stations@1", "busy-stations@1"]);
    expect(list.templates[1]).toEqual({
      id: "harbour-stations", kind: "map", version: 1, title: A1.facts.title, question: A1.facts.question, place: A1.facts.place,
      tags: A1.facts.tags, dataDate: A1.facts.dataDate, sources: A1.facts.sources, origin: "catalogue", installed: null, listed: 1,
      present: false, size: A1.size, picture: "kept",
    });
    expect(list.catalogue).toMatchObject({ state: "listed", host: catalogue.origin, folder: false, reason: null, status: null });
    expect(Date.parse(list.catalogue.readAt!)).not.toBeNaN();
    expect(indexRequests()).toBe(1);
    expect(picturePaths().sort()).toEqual(["/pictures/harbour-stations-1-dark.png", "/pictures/harbour-stations-1-light.png"]);
    // The pictures answer as the catalogue served them; the shipped and
    // downloaded ones from disk.
    expect(await templatePicture("harbour-stations", "dark", f.db)).toEqual(A1.files.binaries.get("pictures/dark.png"));
    expect(await templatePicture("quiet-park", "light", f.db)).toEqual(C1.files.binaries.get("pictures/light.png"));
    expect(await templatePicture("busy-stations", "dark", f.db)).toEqual(B1.files.binaries.get("pictures/dark.png"));
    expect(await listTemplates(f.db)).toEqual(list);
    expect(indexRequests()).toBe(1);
  });

  it("lets a shipped id win over an entry naming it, never asking for its pictures", async () => {
    await ship(A1);
    await catalogue.publish([A2, C1]);
    const list = await refreshCatalogue(f.db);
    expect(ids(list.templates)).toEqual(["harbour-stations@1", "quiet-park@1"]);
    expect(list.templates[0]).toMatchObject({ origin: "shipped", installed: 1, listed: null, present: true, title: A1.facts.title });
    expect(picturePaths().filter((p) => p.includes("harbour"))).toEqual([]);
  });

  it("draws an entry naming the installed version as installed, whatever its checksum, its pictures from disk", async () => {
    await download(B1);
    await catalogue.publish([B1], { edit: (index) => { index.templates[0].sha256 = "0".repeat(64); index.templates[0].size = 1; } });
    const [card] = (await refreshCatalogue(f.db)).templates;
    expect(card).toMatchObject({ id: "busy-stations", version: 1, installed: 1, listed: 1, present: true, size: B1.size, picture: "kept" });
    expect(picturePaths()).toEqual([]);
  });

  it("shows a newer listed version on the card, absent with its size, beside the installed one", async () => {
    await download(B1);
    await catalogue.publish([B2]);
    const [card] = (await refreshCatalogue(f.db)).templates;
    expect(card).toMatchObject({ id: "busy-stations", version: 2, title: B2.facts.title, installed: 1, listed: 2, present: false, size: B2.size, picture: "kept" });
    expect(await templatePicture("busy-stations", "light", f.db)).toEqual(B2.files.binaries.get("pictures/light.png"));
  });

  it("reads one template with how it is made, and refuses an id no template has", async () => {
    await catalogue.publish([B1]);
    await refreshCatalogue(f.db);
    expect(await readTemplate("busy-stations", f.db)).toMatchObject({ id: "busy-stations", version: 1, howMade: B1.facts.howMade });
    await expect(readTemplate("no-such-template", f.db)).rejects.toMatchObject({ code: "template_not_listed", status: 404 });
    await expect(templatePicture("no-such-template", "light", f.db)).rejects.toMatchObject({ code: "template_not_listed" });
  });
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("each state of the catalogue, the shipped and downloaded templates listed under every one", () => {
  const cases: [string, () => Promise<void>, Record<string, unknown>, number][] = [
    ["off", async () => { await catalogue.publish([A1]); switchOff(); }, { state: "off", reason: null }, 0],
    ["unreachable", async () => { vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", `http://127.0.0.1:${await closedPort()}/index.json`); },
      { state: "unreachable", reason: null }, 0],
    ["slow", async () => { vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "0.2"); catalogue.stall(`/${CATALOGUE_INDEX_FILE}`); }, { state: "slow", reason: null }, 1],
    ["empty", async () => { await catalogue.publish([]); }, { state: "empty", reason: null }, 1],
    ["refused with a status", async () => { catalogue.status(`/${CATALOGUE_INDEX_FILE}`, 503); }, { state: "refused", reason: "status", status: 503 }, 1],
    ["refused by the egress rules", async () => { await catalogue.publish([A1]); vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", ""); },
      { state: "refused", reason: "egress_blocked" }, 0],
  ];

  it.each(cases)("%s: its line, the rest listed, the requests counted", async (_name, arrange, expected, requests) => {
    await ship(C1);
    await download(B1);
    await arrange();
    const list = (_name === "off")
      ? await refreshCatalogue(f.db).then(() => { throw new Error("expected the refresh refused"); }, async (error: unknown) => {
        expect(error).toMatchObject({ code: "templates_catalogue_off", status: 409 });
        return listTemplates(f.db);
      })
      : await refreshCatalogue(f.db);
    expect(ids(list.templates)).toEqual(["quiet-park@1", "busy-stations@1"]);
    expect(list.catalogue).toMatchObject({ status: null, ...expected });
    expect(catalogue.requests).toHaveLength(requests);
    expect(await listTemplates(f.db)).toEqual(list);
  });

  it("refused when a saved address no longer opens: the list says why, a refresh refuses, nothing is sent", async () => {
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", undefined);
    writeStoredSettings({ templatesCatalogueUrl: catalogue.indexUrl }, f.db);
    await catalogue.publish([A1]);
    expect((await refreshCatalogue(f.db)).catalogue).toMatchObject({ state: "listed", host: catalogue.origin });
    vi.stubEnv("DEZFIL_SECRET_KEY", "5e".repeat(32));
    resetSecretKeyCache();
    await ship(C1);
    const list = await listTemplates(f.db);
    expect(ids(list.templates)).toEqual(["quiet-park@1"]);
    expect(list.catalogue).toEqual({ state: "refused", host: null, folder: false, readAt: null, reason: "service_address_unreadable", status: null });
    await expect(refreshCatalogue(f.db)).rejects.toMatchObject({ code: "service_address_unreadable" });
    expect(indexRequests()).toBe(1);
  });
});

describe("the index's refusals, each coded and refusing it whole", () => {
  const cases: [string, (index: CatalogueIndex) => void, string][] = [
    ["an id twice", (index) => { index.templates.push(structuredClone(index.templates[0])); }, "template_index_repeats_id"],
    ["an archive on another host", (index) => { index.templates[1].archive = `${catalogue.secondOrigin}/archives/busy.zip`; }, "template_address_outside"],
    ["a picture on another host", (index) => { index.templates[0].pictures.dark = "http://127.0.0.1:9/pictures/dark.png"; }, "template_address_outside"],
    ["a scheme that is not the web's", (index) => { index.templates[0].archive = "file:///etc/passwd"; }, "template_address_outside"],
    ["facts the format does not admit", (index) => { (index.templates[1].facts as { tags: string[] }).tags = ["Unknown"]; }, "template_index_invalid"],
    ["an id the API's paths take as a word", (index) => { index.templates[1].facts.id = "refresh"; }, "template_index_invalid"],
    ["an index format this server does not read", (index) => { index.formatVersion = 2; }, "template_index_invalid"],
    ["a size past the archive bound", (index) => { index.templates[0].size = 151 * 1024 * 1024; }, "template_index_invalid"],
  ];

  it.each(cases)("%s", async (_name, edit, reason) => {
    await ship(C1);
    await catalogue.publish([A1, B1], { edit });
    const list = await refreshCatalogue(f.db);
    expect(ids(list.templates)).toEqual(["quiet-park@1"]);
    expect(list.catalogue).toMatchObject({ state: "refused", reason, status: null });
    expect(picturePaths()).toEqual([]);
  });

  it("not JSON, and over its bound", async () => {
    catalogue.serve(`/${CATALOGUE_INDEX_FILE}`, "{ not json", { type: "application/json" });
    expect((await refreshCatalogue(f.db)).catalogue).toMatchObject({ state: "refused", reason: "template_index_invalid" });
    resetCatalogueForTests();
    const index: CatalogueIndex = { formatVersion: 1, templates: [] };
    catalogue.serve(`/${CATALOGUE_INDEX_FILE}`, JSON.stringify(index) + " ".repeat(TEMPLATE_INDEX_MAX_BYTES), { type: "application/json" });
    expect((await refreshCatalogue(f.db)).catalogue).toMatchObject({ state: "refused", reason: "template_index_too_large" });
  });

  it("leaves out an entry in a newer template format and lists the rest", async () => {
    await catalogue.publish([A1, B1], { edit: (index) => { index.templates[0].facts.formatVersion = TEMPLATE_FORMAT_VERSION + 1; } });
    const list = await refreshCatalogue(f.db);
    expect(ids(list.templates)).toEqual(["busy-stations@1"]);
    expect(picturePaths().filter((p) => p.includes("harbour"))).toEqual([]);
  });

  it("keeps a downloaded version listed when the index is refused", async () => {
    await download(B1);
    await catalogue.publish([A1, B2], { edit: (index) => { index.templates.push(structuredClone(index.templates[0])); } });
    const list = await refreshCatalogue(f.db);
    expect(list.templates).toEqual([expect.objectContaining({ id: "busy-stations", version: 1, present: true, listed: null })]);
  });
});

describe("the pictures", () => {
  it("refuses a picture past its bound alone, and keeps the rest", async () => {
    await catalogue.publish([A1, B1, C1]);
    catalogue.serve("/pictures/busy-stations-1-light.png", Buffer.alloc(TEMPLATE_PICTURE_MAX_BYTES + 1, 7), { type: "image/png" });
    const list = await refreshCatalogue(f.db);
    expect(list.templates.map((c) => [c.id, c.picture])).toEqual([["harbour-stations", "kept"], ["busy-stations", "too_large"], ["quiet-park", "kept"]]);
    expect(list.catalogue.state).toBe("listed");
    expect(await templatePicture("busy-stations", "dark", f.db)).toBeNull();
    expect(await templatePicture("quiet-park", "dark", f.db)).toEqual(C1.files.binaries.get("pictures/dark.png"));
  });

  it("keeps none for an entry whose picture is missing or not a PNG", async () => {
    await catalogue.publish([A1, B1, C1]);
    catalogue.status("/pictures/harbour-stations-1-dark.png", 404);
    catalogue.serve("/pictures/busy-stations-1-light.png", "<svg/>", { type: "image/png" });
    const list = await refreshCatalogue(f.db);
    expect(list.templates.map((c) => c.picture)).toEqual(["not_kept", "not_kept", "kept"]);
  });

  it("stops at the pictures' total: later entries are drawn without one and never asked for", async () => {
    await catalogue.publish([A1, B1, C1]);
    const pair = (t: BuiltTemplate) => t.files.binaries.get("pictures/light.png")!.length + t.files.binaries.get("pictures/dark.png")!.length;
    const list = await refreshCatalogue(f.db, { pictureTotal: pair(A1) + pair(B1) - 1 });
    expect(list.templates.map((c) => c.picture)).toEqual(["kept", "not_kept", "not_kept"]);
    expect(picturePaths().filter((p) => p.includes("quiet-park"))).toEqual([]);
  });
});

describe("the ten-minute rule", () => {
  it("sends nothing for a refresh inside the window, and reads again after it", async () => {
    await catalogue.publish([A1]);
    const at = Date.now();
    await refreshCatalogue(f.db, { now: at });
    const sent = catalogue.requests.length;
    expect(sent).toBe(3);
    await refreshCatalogue(f.db, { now: at + REFRESH_WINDOW_MS - 1 });
    expect(catalogue.requests).toHaveLength(sent);
    await catalogue.publish([A1, C1]);
    const later = await refreshCatalogue(f.db, { now: at + REFRESH_WINDOW_MS });
    expect(ids(later.templates)).toEqual(["harbour-stations@1", "quiet-park@1"]);
    expect(indexRequests()).toBe(2);
  });

  it("holds a failed read for the window too", async () => {
    catalogue.status(`/${CATALOGUE_INDEX_FILE}`, 500);
    const at = Date.now();
    await refreshCatalogue(f.db, { now: at });
    await catalogue.publish([A1]);
    expect((await refreshCatalogue(f.db, { now: at + 60_000 })).catalogue).toMatchObject({ state: "refused", status: 500 });
    expect(indexRequests()).toBe(1);
  });

  it("joins a read under way: two refreshes at once send one", async () => {
    const index = await catalogue.publish([A1]);
    const held = catalogue.hold(`/${CATALOGUE_INDEX_FILE}`, JSON.stringify(index), { type: "application/json" });
    const first = refreshCatalogue(f.db);
    await held.arrived;
    const second = refreshCatalogue(f.db);
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(ids(a.templates)).toEqual(["harbour-stations@1"]);
    expect(indexRequests()).toBe(1);
  });

  it("answers the previous list until a new read is whole", async () => {
    await catalogue.publish([A1]);
    const at = Date.now();
    await refreshCatalogue(f.db, { now: at });
    const index = await catalogue.publish([A2]);
    const held = catalogue.hold(`/${CATALOGUE_INDEX_FILE}`, JSON.stringify(index), { type: "application/json" });
    const refreshing = refreshCatalogue(f.db, { now: at + REFRESH_WINDOW_MS });
    await held.arrived;
    expect(ids((await listTemplates(f.db)).templates)).toEqual(["harbour-stations@1"]);
    held.release();
    expect(ids((await refreshing).templates)).toEqual(["harbour-stations@2"]);
    expect(ids((await listTemplates(f.db)).templates)).toEqual(["harbour-stations@2"]);
  });

  it("drops the kept list when the address changes, and discards a read that finishes after it", async () => {
    const index = await catalogue.publish([A1]);
    const held = catalogue.hold(`/${CATALOGUE_INDEX_FILE}`, JSON.stringify(index), { type: "application/json" });
    const refreshing = refreshCatalogue(f.db);
    await held.arrived;
    const other = await startLoopbackCatalogue();
    try {
      await other.publish([C1]);
      vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", other.indexUrl);
      held.release();
      const answered = await refreshing;
      expect(answered.templates).toEqual([]);
      expect(answered.catalogue).toMatchObject({ state: "not_read", host: other.origin });
      expect((await listTemplates(f.db)).catalogue.state).toBe("not_read");
      expect(other.requests).toEqual([]);
      expect(ids((await refreshCatalogue(f.db)).templates)).toEqual(["quiet-park@1"]);
    } finally {
      await other.close();
    }
  });

  it("discards a read that finishes after the switch went off and on again, the address the same", async () => {
    const index = await catalogue.publish([A1]);
    const held = catalogue.hold(`/${CATALOGUE_INDEX_FILE}`, JSON.stringify(index), { type: "application/json" });
    const refreshing = refreshCatalogue(f.db);
    await held.arrived;
    switchOff();
    expect((await listTemplates(f.db)).catalogue.state).toBe("off");
    writeStoredSettings({ "templates.catalogue": true }, f.db);
    expect((await listTemplates(f.db)).catalogue.state).toBe("not_read");
    held.release();
    expect(await refreshing).toMatchObject({ templates: [], catalogue: { state: "not_read" } });
    expect((await listTemplates(f.db)).catalogue.state).toBe("not_read");
  });

  it("drops the kept list when the switch goes off, and reads again once it is on", async () => {
    await catalogue.publish([A1]);
    await refreshCatalogue(f.db);
    switchOff();
    expect(await listTemplates(f.db)).toMatchObject({ templates: [], catalogue: { state: "off", host: catalogue.origin } });
    writeStoredSettings({ "templates.catalogue": true }, f.db);
    expect((await listTemplates(f.db)).catalogue.state).toBe("not_read");
    expect(ids((await refreshCatalogue(f.db)).templates)).toEqual(["harbour-stations@1"]);
    expect(indexRequests()).toBe(2);
  });
});

describe("no credential on any request", () => {
  it("leaves the address's user name and password out of the index and picture requests", async () => {
    await catalogue.publish([A1], { absolute: true, edit: (index) => {
      index.templates[0].pictures.light = index.templates[0].pictures.light.replace("http://", "http://seed-user:SEEDED-KEY-0005-PICTURE@");
    } });
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl.replace("http://", "http://seed-user:SEEDED-KEY-0005-USER@"));
    const list = await refreshCatalogue(f.db);
    expect(list.templates[0].picture).toBe("kept");
    expect(catalogue.requests).toHaveLength(3);
    for (const request of catalogue.requests) expect(request.headers.authorization).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("SEEDED-KEY-0005");
  });

  it("does not follow a redirect naming a user name or password", async () => {
    await catalogue.publish([A1]);
    catalogue.redirect("/pictures/harbour-stations-1-light.png", `http://seed-user:SEEDED-KEY-0005-HOP@127.0.0.1:${new URL(catalogue.secondOrigin).port}/p.png`);
    const list = await refreshCatalogue(f.db);
    expect(list.templates[0].picture).toBe("not_kept");
    expect(catalogue.requests.filter((r) => r.host === "second")).toEqual([]);
  });
});

describe("the catalogue on a folder", () => {
  it("is read as files under the same checks, named by the variable alone, its path never given", async () => {
    const folder = path.join(dir, "catalogue");
    await writeFolderCatalogue(folder, [A1, B1]);
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", folder);
    const list = await refreshCatalogue(f.db);
    expect(ids(list.templates)).toEqual(["harbour-stations@1", "busy-stations@1"]);
    expect(list.catalogue).toMatchObject({ state: "listed", host: null, folder: true });
    expect(JSON.stringify(list)).not.toContain(dir);
    expect(await templatePicture("busy-stations", "light", f.db)).toEqual(B1.files.binaries.get("pictures/light.png"));
    expect(catalogue.requests).toEqual([]);
  });

  it("refuses an index naming a file outside its folder", async () => {
    const folder = path.join(dir, "catalogue");
    await writeFolderCatalogue(folder, [A1], { edit: (index) => { index.templates[0].archive = "../outside.zip"; } });
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", folder);
    expect((await refreshCatalogue(f.db)).catalogue).toMatchObject({ state: "refused", reason: "template_address_outside", folder: true });
  });

  it("is unreachable without its index", async () => {
    const folder = path.join(dir, "empty-folder");
    await mkdir(folder);
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", folder);
    expect((await refreshCatalogue(f.db)).catalogue).toMatchObject({ state: "unreachable", folder: true });
  });
});

describe("the catalogue's Test", () => {
  const test = () => testService(f.context, "templates", f.db);

  it("passes with how many templates the index lists and the time taken, reading no picture and keeping nothing", async () => {
    await catalogue.publish([A1, B1]);
    const answer = await test();
    expect(answer).toEqual({ service: "templates", result: "passed", templates: 2, milliseconds: expect.any(Number) });
    expect(catalogue.requests.map((r) => r.path)).toEqual([`/${CATALOGUE_INDEX_FILE}`]);
    expect((await listTemplates(f.db)).catalogue.state).toBe("not_read");
  });

  it("passes on the folder the variable names", async () => {
    const folder = path.join(dir, "catalogue");
    await writeFolderCatalogue(folder, [A1]);
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", folder);
    expect(await test()).toMatchObject({ service: "templates", result: "passed", templates: 1 });
  });

  it("is refused by the egress rules, with their sentence, before anything is sent", async () => {
    await catalogue.publish([A1]);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    expect(await test()).toEqual({ service: "templates", result: "failed", reason: "refused", message: egressBlockedError().message });
    expect(catalogue.requests).toEqual([]);
  });

  it("gives the services' other reasons, each from its fixture", async () => {
    catalogue.status(`/${CATALOGUE_INDEX_FILE}`, 404);
    expect(await test()).toEqual({ service: "templates", result: "failed", reason: "status", status: 404 });
    catalogue.serve(`/${CATALOGUE_INDEX_FILE}`, JSON.stringify({ formatVersion: 1, templates: [{}] }), { type: "application/json" });
    expect(await test()).toEqual({ service: "templates", result: "failed", reason: "unexpected_answer" });
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", `http://127.0.0.1:${await closedPort()}/index.json`);
    expect(await test()).toEqual({ service: "templates", result: "failed", reason: "unreachable" });
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl);
    vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "0.2");
    catalogue.stall(`/${CATALOGUE_INDEX_FILE}`);
    expect(await test()).toEqual({ service: "templates", result: "failed", reason: "timed_out" });
  });

  it("is refused while the catalogue is off, and sends nothing", async () => {
    await catalogue.publish([A1]);
    switchOff();
    await expect(test()).rejects.toMatchObject({ code: "templates_catalogue_off", status: 409 });
    expect(catalogue.requests).toEqual([]);
  });

  it("is refused for a saved address the key no longer opens, as every service's is", async () => {
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", undefined);
    writeStoredSettings({ templatesCatalogueUrl: catalogue.indexUrl }, f.db);
    vi.stubEnv("DEZFIL_SECRET_KEY", "5e".repeat(32));
    resetSecretKeyCache();
    const refused = await test().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: "service_address_unreadable" });
    expect(catalogue.requests).toEqual([]);
  });
});

describe("what the list never gives", () => {
  it("names no address but its scheme and host, and no folder", async () => {
    await catalogue.publish([A1]);
    const keyed = catalogue.indexUrl.replace("/index.json", "/SEEDED-KEY-0005-PATH/../index.json?key=SEEDED-KEY-0005-QUERY");
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", keyed);
    const list = await refreshCatalogue(f.db);
    expect(list.catalogue.host).toBe(catalogue.origin);
    expect(JSON.stringify(list)).not.toMatch(/SEEDED-KEY-0005|index\.json|archives\//);
    const detail = await readTemplate("harbour-stations", f.db);
    expect(JSON.stringify(detail)).not.toMatch(/SEEDED-KEY-0005|archives\/|pictures\//);
  });
});
