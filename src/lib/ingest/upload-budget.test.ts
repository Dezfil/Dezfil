import { writeFileSync } from "node:fs";
import { extractArchive } from "./container";
import { expectSettingRemedy } from "../../../test-support/setting-remedy";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { Readable } from "node:stream";
import * as network from "@/lib/net/remote-fetch";
import { importFromUrl } from "./remote";
import { refreshTable } from "./refresh";
import { POST } from "@/app/api/tables/route";
import * as receiver from "./receive";
import { buildZip } from "../../../test-support/zip";
import { buildKml } from "../../../test-support/kml";

const root = process.env.DEZFIL_DATA_DIR!;
beforeEach(() => {
  closeMetadataDb(); vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "upload-budget-")));
  vi.stubEnv("DEZFIL_UPLOAD_MAX_MB", ""); metadataDb();
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); });
const write = (mb: number) => writeStoredSettings({ uploadMaxMb: mb }, metadataDb());
const padding = " ".repeat(1.5 * 1024 ** 2);
function archive() {
  return buildZip([{ name: "doc.kml", data: buildKml([{ name: "Points", points: [[1, 2, "Point"]] }]) },
    { name: "padding.txt", data: padding }]);
}
function multipart(data: Uint8Array, filename: string) {
  const form = new FormData(); form.set("file", new File([new Uint8Array(data)], filename));
  return new Request("http://instance.test/api/tables", { method: "POST", body: form });
}

it.each([[2, 1, true], [1, 2, false]] as const)("keeps the admitted %s MB budget when receipt sees a change to %s MB", async (initial, next, succeeds) => {
  write(initial);
  const wire = multipart(new TextEncoder().encode(padding), "large.csv");
  const bytes = new Uint8Array(await wire.arrayBuffer());
  const pulled = Promise.withResolvers<void>(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { pulled.resolve(); } });
  const pending = receiver.receiveUpload(new Request(wire.url, { method: "POST", headers: wire.headers, body, duplex: "half" } as RequestInit));
  void pending.catch(() => {}); await pulled.promise;
  write(next); controller.enqueue(bytes); controller.close();
  if (succeeds) expect((await pending).filename).toBe("large.csv");
  else await expect(pending).rejects.toMatchObject({ code: "upload_too_large", message: expect.stringContaining("1 MB") });
});

it.each([[2, 1, 201], [1, 2, 413]] as const)("carries the upload's %s MB admission through the route and GDAL after a change to %s MB", async (initial, next, status) => {
  write(initial);
  const zipped = archive();
  const original = receiver.receiveUpload;
  vi.spyOn(receiver, "receiveUpload").mockImplementation(async (...args) => {
    const admitted = await original(...args); write(next); return admitted;
  });
  const response = await POST(testAccountRequest(multipart(zipped, "points.kmz")));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  if (status === 201) expect(result.rowCount).toBe(1);
  else expect(result.error).toMatchObject({ code: "archive_too_large", message: expect.stringContaining("cap is 1 MB") });
});

it("carries a link import and its spatial refresh budget from download through GDAL", async () => {
  const scope = testAccountScope();
  vi.spyOn(network, "openRemote").mockImplementation(async () => {
    write(1);
    return { statusCode: 200, headers: {}, body: Readable.from([archive()]) as network.RemoteResponse["body"], finalUrl: "https://example.test/points.kmz" };
  });
  write(2);
  const imported = await importFromUrl(scope, "https://example.test/points.kmz");
  expect(imported.tables[0].rowCount).toBe(1);
  write(2);
  const refreshed = await refreshTable(scope, imported.tables[0].name);
  expect(refreshed.rowCount).toBe(1);
  expect(network.openRemote).toHaveBeenCalledTimes(2);
});

it.each([false, true])("keeps upload and archive refusals with locked=%s remedies", async locked => {
  write(1);
  if (locked) vi.stubEnv("DEZFIL_UPLOAD_MAX_MB", "1");
  const zip = path.join(process.env.DEZFIL_DATA_DIR!, "large.zip");
  writeFileSync(zip, archive());
  for (const [pending, code] of [
    [() => receiver.receiveUpload(multipart(new TextEncoder().encode(padding), "large.csv")), "upload_too_large"],
    [() => extractArchive(zip, path.join(process.env.DEZFIL_DATA_DIR!, "unpacked"), "large.zip"), "archive_too_large"],
  ] as const) {
    const error = await pending().catch(error => error);
    expect(error).toMatchObject({ code, status: 413 });
    expectSettingRemedy(error.message, "Largest upload", "DEZFIL_UPLOAD_MAX_MB", locked);
  }
});
