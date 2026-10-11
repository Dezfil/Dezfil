import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// The engine reads through its own HTTP client, which no guard in this
// process sees: it is a recorder here, so nothing it would ask can leave.
const engine = vi.hoisted(() => ({ connect: vi.fn(), statements: [] as string[] }));
vi.mock("@/lib/duckdb", () => ({ withConnection: engine.connect }));
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { resolveRemoteSource } from "./remote";

/**
 * The credentialed object road with an S3 address an admin stored: its size
 * probe asks the address in effect, and a stored address the instance's key
 * no longer opens refuses the read, as on the anonymous road, rather than
 * let the read go on without it.
 */

keepRequestsOnThisMachine();

const root = process.env.DEZFIL_DATA_DIR!;
let store: Server;
let origin: string;
let asked: string[];

beforeEach(async () => {
  closeMetadataDb();
  vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "credentialed-road-")));
  vi.stubEnv("DEZFIL_S3_ENDPOINT", "");
  vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", "true");
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "7a".repeat(32));
  resetSecretKeyCache();
  engine.statements = [];
  engine.connect.mockReset();
  engine.connect.mockImplementation(async (work: (conn: unknown) => Promise<unknown>) => work({
    run: async (sql: string) => { engine.statements.push(sql); },
  }));
  asked = [];
  store = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-length": "64" });
    res.end();
  });
  await new Promise<void>((resolve) => store.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  writeStoredSettings({ s3Endpoint: origin }, metadataDb());
});

afterEach(async () => {
  await new Promise<void>((resolve) => store.close(() => resolve()));
  closeMetadataDb();
  vi.unstubAllEnvs();
  resetSecretKeyCache();
});

it("probes the stored S3 address in effect before the engine reads", async () => {
  const source = await resolveRemoteSource("s3://bucket/points.csv");
  await source.cleanup();
  expect(asked).toEqual(["HEAD /bucket/points.csv"]);
  expect(engine.connect).toHaveBeenCalled();
});

it("refuses a read while the stored S3 address cannot be opened with the instance's key, before the engine or any request", async () => {
  vi.stubEnv("DEZFIL_SECRET_KEY", "8b".repeat(32));
  resetSecretKeyCache();
  const outcome = await resolveRemoteSource("s3://bucket/points.csv").then(
    async (source) => { await source.cleanup(); return "read"; },
    (error: unknown) => error,
  );
  expect(outcome).toMatchObject({ code: "service_address_unreadable", status: 400 });
  expect(asked).toEqual([]);
  expect(engine.connect).not.toHaveBeenCalled();
  expect(engine.statements).toEqual([]);
});
