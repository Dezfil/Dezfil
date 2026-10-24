import { isolatePictureData } from "@/lib/test-support/picture-data";
import { encodePng } from "@/lib/export/png-codec";
import type { PictureState } from "./state";
import { afterAll, expect, it, vi } from "vitest";
const race = vi.hoisted(() => ({ afterBytes: undefined as (() => void) | undefined, suffix: ".png" }));
vi.mock("node:fs/promises", async load => {
  const fs = await load<typeof import("node:fs/promises")>();
  // The change lands once the read has settled, whether it found its file or not.
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => { try { return await fs.readFile(...args); } finally { if (String(args[0]).endsWith(race.suffix) && race.afterBytes) { const change = race.afterBytes; race.afterBytes = undefined; change(); } } } };
});
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { createMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { retirementsSettled } from "@/lib/ingest/retire";
import { closeMetadataDb } from "@/lib/metadata/db";
import { documentFacts } from "@/lib/metadata/document-facts";
import { removeProjectPerson, setProjectPerson } from "@/lib/metadata/project-people";
import { resetQueryInstance } from "@/lib/duckdb";
import { readPicture, readThumbnail, saveThumbnail } from "@/lib/map-thumbnails";
import { sizedPicture } from "@/lib/test-support/picture-sizes";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { GET as renderLayer } from "@/app/api/layers/[id]/render/route";
import { mintPictureCredential } from "./credential";
import { readAttemptInputs } from "./inputs";
import { pictureTarget, publishPicture } from "./publication";
import { requestPicture, getPictureState } from "./state";
import { PictureService } from "./service";
import { observePictureChanges, observePictureDataChanges } from "./hooks";
isolatePictureData();
afterAll(async () => { await retirementsSettled(); resetQueryInstance(); closeMetadataDb(); vi.unstubAllEnvs(); });
it("serves owner, Editor and Viewer by consumed-input reach, rechecks after bytes, and refreshes through the real data boundary", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  const owner = testAccountScope(undefined, "owner"), editor = testAccountScope(undefined, "editor"), viewer = testAccountScope(undefined, "viewer"), dataOwner = testAccountScope(undefined, "data");
  let value = 1;
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/csv" }); response.end(`v,lon,lat\n${value},1,2\n`); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/roads.csv`;
  let now = Date.now();
  let work: (state: PictureState) => Promise<void> = async () => {};
  const service = new PictureService({ now: () => now, baseUrl: "http://fixture.test", available: () => true, run: state => work(state) });
  const stop = observePictureDataChanges(id => { service.dataChanged(id); });
  try {
    const table = (await importFromUrl(dataOwner, url, "roads")).tables[0];
    shareProject(dataOwner.accountId, "data-project", [[owner.accountId, "viewer"], [editor.accountId, "viewer"], [viewer.accountId, "viewer"]], [table.id]);
    shareProject(owner.accountId, "map-project", [[editor.accountId, "editor"], [viewer.accountId, "viewer"]]);
    const map = createMap(owner, "Reach", "map-project");
    const revision = () => ({ expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
    const layer = await createLayer(owner, map.id, { name: "Roads", sql: "SELECT * FROM data.roads" }, revision());
    service.clearPendingData(); await service.request(map.id);
    const target = pictureTarget(owner, map.id), state = getPictureState(map.id)!;
    const credential = mintPictureCredential(map.id, Date.now() + 60000);
    const response = await renderLayer(socketRequest(new Request(`http://fixture.test/api/layers/${layer.id}/render`, { headers: { "x-dezfil-picture-work": credential } })), { params: Promise.resolve({ id: layer.id }) });
    expect((await response.json()).ok).toBe(true);
    const inputs = readAttemptInputs(credential, [layer.id]);
    expect(inputs.datasets).toEqual([{ id: table.id, file: table.file }]);
    await publishPicture(owner, target, state.requestedGeneration, { light: sizedPicture("light", Buffer.from("light")), dark: sizedPicture("dark", Buffer.from("dark")) }, inputs);
    for (const scope of [owner, editor, viewer]) expect((await readThumbnail(scope, map.id))?.toString()).toBe("light");
    race.afterBytes = () => { removeProjectPerson(dataOwner, "data-project", "viewer"); };
    expect(await readThumbnail(viewer, map.id)).toBeNull();
    expect((await readThumbnail(editor, map.id))?.toString()).toBe("light");
    setProjectPerson(dataOwner, "data-project", "viewer", "viewer");
    // Reach lost while a kept size is read: neither the size nor the PNG in its place is served.
    const wide = { shape: "wide" as const, width: 2000 };
    expect((await readPicture(viewer, map.id, "light", wide))?.bytes.toString()).toBe("light:card-2904");
    race.suffix = ".webp";
    race.afterBytes = () => { removeProjectPerson(dataOwner, "data-project", "viewer"); };
    expect(await readPicture(viewer, map.id, "light", wide)).toBeNull();
    expect((await readPicture(editor, map.id, "light", wide))?.bytes.toString()).toBe("light:card-2904");
    setProjectPerson(dataOwner, "data-project", "viewer", "viewer");
    const thumbnails = path.join(dataDir(), "thumbnails");
    for (const name of readdirSync(thumbnails).filter(name => name.startsWith(map.id) && name.endsWith(".card-2904.webp"))) rmSync(path.join(thumbnails, name));
    race.afterBytes = () => { removeProjectPerson(dataOwner, "data-project", "viewer"); };
    expect(await readPicture(viewer, map.id, "light", wide)).toBeNull();
    expect((await readPicture(editor, map.id, "light", wide))?.bytes.toString()).toBe("light");
    setProjectPerson(dataOwner, "data-project", "viewer", "viewer");
    race.suffix = ".png";
    const notifications: Promise<unknown>[] = [];
    const stopChanges = observePictureChanges(event => { notifications.push(service.request(event.mapId)); });
    let editorPicture: Buffer | undefined;
    work = async queued => {
      const target = pictureTarget(owner, queued.mapId);
      expect(target.map.layers[0].sql).toContain("11 AS edited");
      const credential = mintPictureCredential(map.id, Date.now() + 60000);
      const rendered = await renderLayer(socketRequest(new Request(`http://fixture.test/api/layers/${layer.id}/render`, { headers: { "x-dezfil-picture-work": credential } })), { params: Promise.resolve({ id: layer.id }) });
      const drawing = await rendered.json();
      expect(drawing).toMatchObject({ ok: true, geojson: { features: [{ properties: { edited: 11 } }] } });
      // Only rasterization is stubbed. Encode the evaluated Editor value,
      // so re-serving the owner's previous bytes cannot satisfy this proof.
      editorPicture = Buffer.from(encodePng({ width: 1, height: 1, rgba: new Uint8Array([drawing.geojson.features[0].properties.edited, 80, 120, 255]) }));
      const consumed = readAttemptInputs(credential, [layer.id]);
      expect(consumed.datasets).toEqual([{ id: table.id, file: table.file }]);
      await publishPicture(owner, target, queued.requestedGeneration, { light: editorPicture, dark: editorPicture }, consumed);
    };
    try {
      await updateLayer(editor, layer.id, { sql: "SELECT *, 11 AS edited FROM data.roads" }, revision());
      await Promise.all(notifications);
      expect(notifications).toHaveLength(1);
      now += 5001; await service.tick(); await service.queue.drain();
    } finally { stopChanges(); work = async () => {}; }
    expect(editorPicture).toBeDefined();
    expect(getPictureState(map.id)).toMatchObject({ state: "current", publishedGeneration: state.requestedGeneration + 1 });
    for (const scope of [owner, editor]) {
      expect(await readThumbnail(scope, map.id)).toEqual(editorPicture);
      expect((await readThumbnail(scope, map.id))?.equals(Buffer.from("light"))).toBe(false);
    }
    const editorState = getPictureState(map.id)!;
    const clock = editorState.drawingChangedAt;
    value = 2; const replacement = await refreshTable(dataOwner, table.name);
    await Promise.resolve(); now += 5000; await service.tick(); await service.queue.drain();
    expect(replacement.file).not.toBe(table.file);
    expect(getPictureState(map.id)).toMatchObject({ requestedGeneration: editorState.requestedGeneration + 1, drawingChangedAt: clock });
    expect(() => readAttemptInputs(credential, [layer.id])).toThrow();
    await expect(publishPicture(owner, target, state.requestedGeneration, { light: Buffer.from("late"), dark: Buffer.from("late") }, inputs)).rejects.toThrow();
    const legacy = createMap(owner, "Unattributed", "map-project"); await saveThumbnail(owner, legacy.id, Buffer.from("legacy"));
    expect(await readThumbnail(owner, legacy.id)).not.toBeNull();
    expect(await readThumbnail(editor, legacy.id)).toBeNull(); expect(await readThumbnail(viewer, legacy.id)).toBeNull();
    removeProjectPerson(dataOwner, "data-project", "owner");
    await updateLayer(editor, layer.id, { sql: "SELECT * FROM data.roads WHERE v > 0" }, revision());
    const changed = pictureTarget(owner, map.id); requestPicture(map.id, changed.digest, Date.now());
    const ownerCredential = mintPictureCredential(map.id, Date.now() + 60000);
    const refused = await renderLayer(socketRequest(new Request(`http://fixture.test/api/layers/${layer.id}/render`, { headers: { "x-dezfil-picture-work": ownerCredential } })), { params: Promise.resolve({ id: layer.id }) });
    expect((await refused.json()).ok).toBe(false);
    work = queued => publishPicture(owner, changed, queued.requestedGeneration, { light: Buffer.from("unreached"), dark: Buffer.from("unreached") }, { catalogue: false, datasets: [{ id: table.id, file: replacement.file }] });
    await expect(work(getPictureState(map.id)!)).rejects.toThrow();
    // Let the actual queue catch that same publication refusal. Merely
    // observing the thrown error would miss a row left waiting forever.
    now = Date.now() + 10000; await service.tick(); await service.queue.drain();
    expect(getPictureState(map.id)).toMatchObject({ state: "failed", publishedGeneration: editorState.publishedGeneration, attemptCount: 1 });
    expect(await readThumbnail(editor, map.id)).toEqual(editorPicture);
  } finally { stop(); await service.drain(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
