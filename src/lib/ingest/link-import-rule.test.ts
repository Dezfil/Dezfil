import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetQueryInstance } from "@/lib/duckdb";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, ROADS, ruleRefusalBody, tokenFor } from "@/lib/test-support/rule-roads";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { resetRefreshFences } from "./fence";
import { importFromUrl } from "./remote";

/**
 * Who may import from links, on every road. Admins only refuses a member a
 * new web-address or cloud-storage import before any request leaves the
 * server, and takes nothing away: a link dataset keeps refreshing. The
 * fixture serves both roads on loopback, which the allowlist admits as an
 * administrator would, and the S3 address points there.
 */
const SENTENCE = "Only admins can import from links on this instance.";
const outbound = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/lib/net/remote-fetch", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/net/remote-fetch")>();
  return { ...actual, openRemote: (...args: Parameters<typeof actual.openRemote>) => {
    outbound.opened.push(args[0]);
    return actual.openRemote(...args);
  } };
});

const saved = { dataDir: process.env.DEZFIL_DATA_DIR };
let dir: string;
let server: Server;
let base: string;
let rows = 2;
let served: string[] = [];
let tokens: Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dezfil-links-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  closeMetadataDb();
  resetRefreshFences();
  resetQueryInstance();
  rows = 2;
  served = [];
  server = createServer((request, response) => {
    served.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/csv" });
    response.end("name,lat,lon\n" + Array.from({ length: rows }, (_, i) => `p${i},52.${i},13.${i}`).join("\n") + "\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("DEZFIL_S3_ENDPOINT", base);
  const db = metadataDb();
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  testAccountScope(db, "member");
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
  // The member's link dataset, imported while everyone could.
  await importFromUrl(testAccountScope(db, "member"), `${base}/points.csv`, "points");
  served = [];
  outbound.opened.length = 0;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeMetadataDb();
  vi.unstubAllEnvs();
  process.env.DEZFIL_DATA_DIR = saved.dataDir;
  await rm(dir, { recursive: true, force: true });
});

async function setLinks(value: "everyone" | "admins") {
  const response = await changeInstanceSettings(testAccountRequest(new Request("http://instance.test/api/instance/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ "imports.links": value }),
  }), metadataDb(), "admin"));
  expect(response.status).toBe(200);
}
const datasets = () => metadataDb().prepare("SELECT id, name, owner_id, source FROM data_tables ORDER BY name").all();
const links = () => [`${base}/roads.csv`, "s3://open-data/rivers.csv"];

describe("who may import from links", () => {
  it.each(ROADS)("under admins, refuses a member a new web-address or cloud-storage import by %s, before any request leaves", async road => {
    await setLinks("admins");
    const before = datasets();
    for (const url of links()) {
      const answer = await callAs(metadataDb(), road, "member", tokens.member, "import_table_from_url", { url });
      expect(answer, url).toEqual({ status: 403, body: ruleRefusalBody("imports.links", SENTENCE) });
    }
    expect(datasets()).toEqual(before);
    expect(outbound.opened).toEqual([]);
    expect(served).toEqual([]);
  });

  it.each(ROADS)("under admins, keeps refreshing a member's link dataset by %s", async road => {
    await setLinks("admins");
    rows = 5;
    const answer = await callAs(metadataDb(), road, "member", tokens.member, "refresh_table", { name: "points" });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as { rowCount: number }).rowCount).toBe(5);
    expect(served).toEqual(["/points.csv"]);
  });

  it.each(ROADS)("under admins, lets an admin import from a web address and from cloud storage by %s", async road => {
    await setLinks("admins");
    for (const url of links()) {
      const answer = await callAs(metadataDb(), road, "admin", tokens.admin, "import_table_from_url", { url });
      expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(201);
    }
    expect(served).toEqual(["/roads.csv", "/open-data/rivers.csv"]);
  });

  it.each(ROADS)("under everyone, lets a member import from a web address and from cloud storage by %s", async road => {
    await setLinks("admins");
    await setLinks("everyone");
    for (const url of links()) {
      const answer = await callAs(metadataDb(), road, "member", tokens.member, "import_table_from_url", { url });
      expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(201);
    }
  });

  it("refuses at the import service itself, whatever road reaches it", async () => {
    await setLinks("admins");
    await expect(importFromUrl(testAccountScope(metadataDb(), "member"), `${base}/roads.csv`)).rejects.toMatchObject({
      code: "rule_refused", status: 403, message: SENTENCE, extra: { rule: "imports.links" },
    });
    expect(outbound.opened).toEqual([]);
  });
});
