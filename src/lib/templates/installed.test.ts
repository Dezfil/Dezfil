import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { admitTemplateFolder } from "./admission";
import { RECORD_FILE, fileSha256, readInstalledVersion, recordProblem, writeInstalledRecord } from "./installed";
import { TemplateRefusal } from "./refusals";
import { FIXTURE_MEASUREMENTS, buildTemplate } from "../../../test-support/templates/builder";

/**
 * The installed form: a version folder and its record. A record written
 * for an admitted folder reads back with the folder; a folder that changed
 * after its record was written (a member altered, added or taken away, the
 * record speaking of another version) is refused, coded.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-installed-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function installed() {
  const built = await buildTemplate(path.join(dir, "built"), { kind: "workflow" });
  const folder = path.join(dir, "installed");
  await cp(built.folder, folder, { recursive: true });
  const admitted = await admitTemplateFolder(folder);
  const measured = Object.fromEntries(Object.entries(FIXTURE_MEASUREMENTS).filter(([m]) => admitted.members.has(m)));
  const record = await writeInstalledRecord(admitted, {
    archive: { sha256: built.sha256, size: built.size },
    origin: { kind: "catalogue", origin: "https://catalogue.example" },
    measured,
  });
  return { built, folder, record };
}

async function refusalOf(work: Promise<unknown>): Promise<TemplateRefusal> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TemplateRefusal) return error;
    throw error;
  }
  throw new Error("The installed version was read.");
}

describe("an installed version and its record", () => {
  it("writes a record of every member, its origin and what was measured, and reads it back", async () => {
    const { built, folder, record } = await installed();
    expect(record).toMatchObject({
      formatVersion: 1,
      id: "busy-stations",
      version: 1,
      archive: { sha256: built.sha256, size: built.size },
      origin: { kind: "catalogue", origin: "https://catalogue.example" },
      measured: FIXTURE_MEASUREMENTS,
    });
    expect(Object.keys(record.files)).toEqual([
      "datasets/districts.parquet", "datasets/stations.parquet", "maps/map.json", "pictures/dark.png",
      "pictures/light.png", "project.json", "results/step-busy.parquet", "results/step-rings.parquet",
      "template.json", "workflows/workflow.json",
    ]);
    expect(record.files["datasets/stations.parquet"].sha256).toBe(await fileSha256(path.join(folder, "datasets/stations.parquet")));
    expect(JSON.parse(await readFile(path.join(folder, RECORD_FILE), "utf8"))).toEqual(record);
    const read = await readInstalledVersion(folder);
    expect(read.record).toEqual(record);
    expect(read.admitted.facts).toEqual(built.facts);
  });

  it("refuses a folder with no record", async () => {
    const built = await buildTemplate(path.join(dir, "built"));
    expect((await refusalOf(readInstalledVersion(built.folder))).code).toBe("template_record_mismatch");
  });

  it("refuses a member altered after the record was written", async () => {
    const { folder } = await installed();
    const file = path.join(folder, "results", "step-rings.parquet");
    const bytes = await readFile(file);
    bytes[bytes.length - 9] ^= 0xff;
    await writeFile(file, bytes);
    const refusal = await refusalOf(readInstalledVersion(folder));
    expect(refusal.code).toBe("template_record_mismatch");
    expect(refusal.message).toBe('The member "results/step-rings.parquet" differs from its record.');
  });

  it("refuses a record that lists a member the folder lost, or misses one it holds", async () => {
    const { folder, record } = await installed();
    await writeFile(path.join(folder, RECORD_FILE), JSON.stringify({ ...record, files: { ...record.files, "datasets/gone.parquet": record.files["datasets/stations.parquet"] } }));
    expect((await refusalOf(readInstalledVersion(folder))).message).toBe('The record lists "datasets/gone.parquet", which the installed version does not hold.');
    const files = { ...record.files };
    delete files["maps/map.json"];
    await writeFile(path.join(folder, RECORD_FILE), JSON.stringify({ ...record, files }));
    expect((await refusalOf(readInstalledVersion(folder))).message).toBe('The installed version holds "maps/map.json", which its record does not list.');
  });

  it("refuses a record of another version", async () => {
    const { folder, record } = await installed();
    await writeFile(path.join(folder, RECORD_FILE), JSON.stringify({ ...record, version: 2 }));
    expect((await refusalOf(readInstalledVersion(folder))).code).toBe("template_record_mismatch");
  });

  it("holds the record's shape: an origin by scheme and host alone, a measurement of every dataset and result", async () => {
    const { record } = await installed();
    expect(recordProblem(record)).toBeNull();
    expect(recordProblem({ ...record, origin: { kind: "catalogue", origin: "https://catalogue.example/releases/index.json" } }))
      .toBe("The record: a catalogue origin names its scheme and host alone.");
    expect(recordProblem({ ...record, origin: { kind: "folder", path: "/srv/catalogue" } })).toBe("The record: its origin carries more than its kind.");
    expect(recordProblem({ ...record, measured: { "datasets/stations.parquet": { rowCount: -1, geometryColumn: null, geometryType: null, crsAssumed: false } } }))
      .toBe('The record\'s measurement of "datasets/stations.parquet": a measurement\'s rowCount must be a count.');
  });

  it("writes a record only with every dataset and result measured", async () => {
    const built = await buildTemplate(path.join(dir, "built"), { kind: "workflow" });
    const admitted = await admitTemplateFolder(built.folder);
    await expect(writeInstalledRecord(admitted, {
      archive: { sha256: built.sha256, size: built.size },
      origin: { kind: "shipped" },
      measured: { "datasets/stations.parquet": FIXTURE_MEASUREMENTS["datasets/stations.parquet"] },
    })).rejects.toThrow("A record measures every dataset and bundled result of the version, and nothing else.");
  });
});
