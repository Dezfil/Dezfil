import { expectSettingRemedy } from "../../../test-support/setting-remedy";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ open: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: network.open }));
vi.mock("@/lib/duckdb", () => ({ withConnection: network.connect }));
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { writeStoredSettings } from "@/lib/settings/store";
import { resolveRemoteSource } from "./remote";
import { prepareSource } from "./gdal-formats";
import type { OpenRemoteOptions } from "@/lib/net/remote-fetch";
import { buildZip } from "../../../test-support/zip";

const root = process.env.DEZFIL_DATA_DIR!;
beforeEach(() => {
  closeMetadataDb(); vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "remote-budget-")));
  for (const key of ["REMOTE_MAX_MB", "REMOTE_TIMEOUT_S", "UPLOAD_MAX_MB", "OBJECT_STORE_CREDENTIALS"]) vi.stubEnv(`DEZFIL_${key}`, "");
  network.open.mockReset(); network.connect.mockReset(); metadataDb();
});
afterEach(() => { closeMetadataDb(); vi.unstubAllEnvs(); });
const write = (patch: Record<string, number>) => writeStoredSettings(patch, metadataDb());
const payload = Buffer.alloc(1.5 * 1024 ** 2, 32);
const response = (body: Buffer, headers = {}) => ({ statusCode: 200, headers, body: Readable.from([body]), finalUrl: "https://example.test/file.csv" });

it.each([[2, 1, true], [1, 2, false]] as const)("keeps the admitted %s MB at response and stream checks after a change to %s MB", async (initial, next, succeeds) => {
  for (const declared of [true, false]) {
    write({ remoteMaxMb: initial });
    network.open.mockImplementation(async () => {
      write({ remoteMaxMb: next });
      return response(payload, declared ? { "content-length": String(payload.length) } : {});
    });
    const pending = resolveRemoteSource("https://example.test/file.csv");
    if (succeeds) { const source = await pending; await source.cleanup(); }
    else await expect(pending).rejects.toMatchObject({ code: "remote_too_large", message: expect.stringContaining("1 MB") });
  }
});

it("uses the admitted link timeout in both the fetch option and a later refusal", async () => {
  write({ remoteTimeoutS: 300 });
  network.open.mockImplementation(async (_url: string, options: OpenRemoteOptions) => {
    expect(options.timeoutMs).toBe(300_000);
    write({ remoteTimeoutS: 10 });
    throw options.timeoutError!();
  });
  await expect(resolveRemoteSource("https://example.test/file.csv")).rejects.toMatchObject({ code: "remote_timeout", message: expect.stringContaining("300 s") });
});

it("carries the remote admission through later archive preparation", async () => {
  write({ uploadMaxMb: 2, remoteMaxMb: 2 });
  const zipped = buildZip([{ name: "doc.kml", data: payload }]);
  network.open.mockResolvedValue(response(zipped));
  const source = await resolveRemoteSource("https://example.test/file.kmz");
  write({ uploadMaxMb: 1 });
  try {
    const prepared = await prepareSource("kml", source.sourcePath, source.filename, undefined, source.budget);
    expect(prepared.datasets).toHaveLength(1);
  } finally { await source.cleanup(); }
});

it.each(["probe", "blob"])("keeps the admitted credentialed-object cap at the later %s check", async stage => {
  vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", "1"); write({ remoteMaxMb: 2 });
  network.open.mockImplementation(async () => {
    if (stage === "probe") write({ remoteMaxMb: 1 });
    return response(Buffer.alloc(0), { "content-length": String(payload.length) });
  });
  network.connect.mockImplementation(async (work: (conn: unknown) => Promise<unknown>) => work({
    run: async () => {}, runAndReadAll: async () => {
      write({ remoteMaxMb: 1 });
      return { getRowObjects: () => [{ content: payload, size: payload.length }] };
    },
  }));
  const source = await resolveRemoteSource("s3://bucket/file.geojson");
  await source.cleanup(); expect(network.connect).toHaveBeenCalled();
});

it.each([false, true])("keeps every link-size refusal with locked=%s remedies", async locked => {
  write({ remoteMaxMb: 1 });
  if (locked) vi.stubEnv("DEZFIL_REMOTE_MAX_MB", "1");
  for (const stage of ["declared", "stream", "probe", "blob"]) {
    vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", stage === "probe" || stage === "blob" ? "1" : "");
    network.open.mockResolvedValue(response(payload, stage === "declared" || stage === "probe" ? { "content-length": String(payload.length) } : {}));
    network.connect.mockImplementation(async (work: (conn: unknown) => Promise<unknown>) => work({
      run: async () => {}, runAndReadAll: async () => ({ getRowObjects: () => [{ content: payload, size: payload.length }] }),
    }));
    const error = await resolveRemoteSource(stage === "probe" || stage === "blob" ? "s3://bucket/file.geojson" : "https://example.test/file.csv").catch(error => error);
    expect(error, stage).toMatchObject({ code: "remote_too_large", status: 413 });
    expectSettingRemedy(error.message, "Largest link import", "DEZFIL_REMOTE_MAX_MB", locked);
  }
});
it.each([false, true])("keeps the link timeout with locked=%s remedies", async locked => {
  write({ remoteTimeoutS: 10 });
  if (locked) vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "10");
  network.open.mockImplementation(async (_url: string, options: OpenRemoteOptions) => { throw options.timeoutError!(); });
  const error = await resolveRemoteSource("https://example.test/file.csv").catch(error => error);
  expect(error).toMatchObject({ code: "remote_timeout", status: 504 });
  expectSettingRemedy(error.message, "Link import time limit", "DEZFIL_REMOTE_TIMEOUT_S", locked);
});
