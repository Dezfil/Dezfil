import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AccountScope } from "@/lib/auth/scope";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { inspectLayerGeometry } from "@/lib/layer-geometry";
import * as metadata from "@/lib/metadata/db";
import { DatasetUnavailable } from "@/lib/query/engine-message";
import { sameContext } from "@/lib/query/written-in";
import { testAccountScope } from "@/lib/test-support/accounts";
import { buildTemplate, installFixture, type BuiltTemplate } from "../../../test-support/templates/builder";
import { prepareTemplateHome, templateArtifactName, templateMapEvaluation, templateStepEvaluation } from "./home";
import { readInstalledVersion, type InstalledVersion } from "./installed";

/**
 * A template's home: its datasets and bundled results made present for the
 * engine without widening its fence, kept (named by content, shared) or own
 * (named for one preparation, gone on release), and an evaluation in it
 * binding the version's names and nothing of the caller's.
 */

let built: string;
let dir: string;
let db: Database;
let scope: AccountScope;
let W1: BuiltTemplate;
let version: InstalledVersion;

const tables = async () => (await readdir(path.join(dataDir(), "tables")).catch(() => [])).sort();

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-home-"));
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-home-run-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  resetQueryInstance();
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  scope = testAccountScope(db, "reader");
  await installFixture(W1, path.join(dir, "installed"));
  version = await readInstalledVersion(path.join(dir, "installed"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetQueryInstance();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a kept home", () => {
  it("stages each file once under its content's name, shared by every preparation, and its release removes nothing", async () => {
    const first = await prepareTemplateHome(version);
    const names = [...first.home.datasets, ...first.home.outputs].map((m) => m.file);
    expect(names).toEqual([
      "datasets/stations.parquet", "datasets/districts.parquet", "results/step-busy.parquet", "results/step-rings.parquet",
    ].map((member) => templateArtifactName(version.record.files[member].sha256)));
    const second = await prepareTemplateHome(version);
    expect([...second.home.datasets, ...second.home.outputs].map((m) => m.file)).toEqual(names);
    expect(await tables()).toEqual(names.map((n) => path.basename(n)).sort());
    await first.release();
    expect(await tables()).toHaveLength(4);
  });
});

describe("an own home", () => {
  it("stages each file for this preparation alone, and its release removes them", async () => {
    const first = await prepareTemplateHome(version, { own: true });
    const second = await prepareTemplateHome(version, { own: true });
    expect(await tables()).toHaveLength(8);
    await first.release();
    expect(await tables()).toEqual([...second.home.datasets, ...second.home.outputs].map((m) => path.basename(m.file)).sort());
    await second.release();
    expect(await tables()).toEqual([]);
  });

  it("a preparation that fails part way leaves nothing", async () => {
    const files = { ...version.record.files };
    delete files["results/step-rings.parquet"];
    await expect(prepareTemplateHome({ admitted: version.admitted, record: { ...version.record, files } }, { own: true })).rejects.toThrow();
    expect(await tables()).toEqual([]);
  });
});

describe("an evaluation in the home", () => {
  it("binds the version's datasets and results, a step only the results before it, and nothing of the caller's", async () => {
    const { home, release } = await prepareTemplateHome(version, { own: true });
    try {
      const map = templateMapEvaluation(scope, home);
      expect(await inspectLayerGeometry(map, "SELECT * FROM station_rings")).toMatchObject({ geometryColumn: "geom" });
      expect(await inspectLayerGeometry(map, "SELECT * FROM stations")).toMatchObject({ geometryColumn: "geom" });
      await expect(inspectLayerGeometry(templateStepEvaluation(scope, home, 1), "SELECT * FROM station_rings")).rejects.toBeInstanceOf(DatasetUnavailable);
      expect(await inspectLayerGeometry(templateStepEvaluation(scope, home, 1), "SELECT * FROM busy_stations")).toMatchObject({ geometryColumn: "geom" });
      await expect(inspectLayerGeometry(map, "SELECT * FROM roads")).rejects.toBeInstanceOf(DatasetUnavailable);
    } finally {
      await release();
    }
  });

  it("is the same context only for the same version", async () => {
    const { home, release } = await prepareTemplateHome(version, { own: true });
    try {
      expect(sameContext(templateMapEvaluation(scope, home), templateMapEvaluation(scope, home))).toBe(true);
      expect(sameContext(templateMapEvaluation(scope, home), templateMapEvaluation(scope, { ...home, version: 2 }))).toBe(false);
      expect(sameContext(templateMapEvaluation(scope, home), templateMapEvaluation(scope, { ...home, template: "other" }))).toBe(false);
    } finally {
      await release();
    }
  });
});
