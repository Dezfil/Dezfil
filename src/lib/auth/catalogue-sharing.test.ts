import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { fileDataset, shareProject } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "./scope";

/**
 * The schema catalogue over reach, as the console's grouping and the
 * assistant read it. Ada owns `roads`, filed in her projects P (shared with
 * Bob) and Q (shared with nobody). Bob owns a `roads` of his own, unfiled, and
 * `parks`, filed in P. Every row says whose it is, the name its reader types,
 * and the projects through which that reader reaches it: never a project the
 * reader does not reach, and the page walk visits each dataset once.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "catalogue-sharing-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["bob", "roads"], ["bob", "parks"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"]], [tables["ada.roads"].id, tables["bob.parks"].id]);
  shareProject("ada", "Q", [], [tables["ada.roads"].id]);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function catalogue(account: string, query: string) {
  const { GET } = await import("@/app/api/catalogue/tables/route");
  const response = await GET(testAccountRequest(new Request(`http://instance.test/api/catalogue/tables${query}`), undefined, account));
  return { status: response.status, body: await response.json() as { tables: Record<string, unknown>[]; total: number; nextAfter: string | null } };
}
/** Every page of one table each, as a paginating client walks it. */
async function walk(account: string) {
  const rows: Record<string, unknown>[] = [];
  let after: string | null = null;
  do {
    const page = await catalogue(account, `?limit=1&columns=0${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    rows.push(...page.body.tables);
    after = page.body.nextAfter;
  } while (after);
  return rows.map(({ id, qualifiedName, owner, projectIds }) => ({ id, qualifiedName, owner, projectIds }));
}

describe("the catalogue over reach", () => {
  it("lists each reached dataset once with its owner and the projects through which the reader reaches it", async () => {
    expect(await walk("bob")).toEqual([
      { id: tables["ada.roads"].id, qualifiedName: "ada.roads", owner: { name: "ada", sqlName: "ada" }, projectIds: ["P"] },
      { id: tables["bob.parks"].id, qualifiedName: "parks", owner: { name: "bob", sqlName: "bob" }, projectIds: ["P"] },
      { id: tables["bob.roads"].id, qualifiedName: "roads", owner: { name: "bob", sqlName: "bob" }, projectIds: [] },
    ]);
    expect(await walk("ada")).toEqual([
      { id: tables["bob.parks"].id, qualifiedName: "bob.parks", owner: { name: "bob", sqlName: "bob" }, projectIds: ["P"] },
      { id: tables["ada.roads"].id, qualifiedName: "roads", owner: { name: "ada", sqlName: "ada" }, projectIds: ["P", "Q"] },
    ]);
    expect(await walk("cyd")).toEqual([]);
  });

  it("follows a filing at the next read, and addresses a same-named dataset by the reader's name for it", async () => {
    fileDataset("P", tables["bob.roads"].id);
    expect((await walk("ada")).map((row) => [row.qualifiedName, row.projectIds])).toEqual([
      ["bob.parks", ["P"]], ["bob.roads", ["P"]], ["roads", ["P", "Q"]],
    ]);
    const theirs = await catalogue("bob", "?names=ada.roads&columns=0");
    const own = await catalogue("bob", "?names=roads&columns=0");
    expect([theirs.body.tables[0].id, own.body.tables[0].id]).toEqual([tables["ada.roads"].id, tables["bob.roads"].id]);
    const hidden = await catalogue("cyd", "?names=ada.roads");
    const never = await catalogue("cyd", "?names=zed.nothing");
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(never);
  });
});
