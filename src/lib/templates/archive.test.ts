import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTemplateArchive } from "./archive";
import { admitTemplateFolder } from "./admission";
import { TEMPLATE_ARCHIVE_MAX_BYTES } from "./format";
import { TemplateRefusal, type TemplateRefusalCode } from "./refusals";
import {
  ARCHIVE_SEEDS,
  FIXTURE_CREDIT_NOTE,
  SEEDS,
  buildTemplate,
  type TemplateFixtureOptions,
} from "../../../test-support/templates/builder";

/**
 * The template reader and the first stage of the admission, each refusal
 * from its own seeded fixture: coded, and leaving nothing where the archive
 * was to be unpacked. The fixture is a real template (datasets the engine
 * wrote, PNG pictures, documents in the export's shape), so a reader that
 * skipped a check would admit the seeded one whole.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-templates-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function refusalOf(work: Promise<unknown>): Promise<TemplateRefusal> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TemplateRefusal) return error;
    throw error;
  }
  throw new Error("The template was admitted.");
}

async function build(options: TemplateFixtureOptions = {}) {
  return buildTemplate(path.join(dir, "fixture"), options);
}

const destination = () => path.join(dir, "unpacked");

describe("reading a template archive", () => {
  it("unpacks and admits a map template, every member named and present", async () => {
    const built = await build();
    const read = await readTemplateArchive(built.archive, destination());
    expect(read.folder).toBe(path.join(destination(), "harbour-stations.dezfil"));
    expect(await readdir(destination())).toEqual(["harbour-stations.dezfil"]);
    expect(read.admitted.facts).toEqual(built.facts);
    expect(read.admitted.map.layers.map((l) => [l.id, l.sql])).toEqual([
      ["layer-stations", "SELECT * FROM stations"],
      ["layer-districts", "SELECT * FROM districts"],
    ]);
    expect(read.admitted.map.legendOrder).toEqual(["layer-districts", "layer-stations"]);
    expect(read.admitted.map.widgets.find((w) => w.type === "note")?.note).toBe(FIXTURE_CREDIT_NOTE);
    expect(read.admitted.workflow).toBeNull();
    expect(read.admitted.datasets).toEqual([
      { name: "stations", file: "datasets/stations.parquet" },
      { name: "districts", file: "datasets/districts.parquet" },
    ]);
    expect([...read.admitted.members.keys()].sort()).toEqual([
      "datasets/districts.parquet",
      "datasets/stations.parquet",
      "maps/map.json",
      "pictures/dark.png",
      "pictures/light.png",
      "project.json",
      "template.json",
    ]);
    expect(read.archiveBytes).toBe(built.size);
  });

  it("unpacks and admits a workflow example with its steps, results and layout", async () => {
    const built = await build({ kind: "workflow" });
    const read = await readTemplateArchive(built.archive, destination());
    const workflow = read.admitted.workflow!;
    expect(workflow.steps.map((s) => [s.id, s.operation, s.output, s.result])).toEqual([
      ["step-busy", "sql_step", "busy_stations", "results/step-busy.parquet"],
      ["step-rings", "buffer", "station_rings", "results/step-rings.parquet"],
    ]);
    expect(workflow.layout.steps).toEqual({ "step-busy": { x: 320, y: 40 }, "step-rings": { x: 620, y: 40 } });
    expect(workflow.layout.notes.map((n) => n.id)).toEqual(["note-1"]);
    expect(read.admitted.members.has("results/step-rings.parquet")).toBe(true);
  });

  it("admits the installed form, the same members unpacked, with the form's own extra member", async () => {
    const built = await build({ kind: "workflow" });
    await expect(admitTemplateFolder(built.folder)).resolves.toMatchObject({ facts: built.facts });
    await writeFile(path.join(built.folder, "record.json"), "{}");
    await expect(admitTemplateFolder(built.folder, { extraMembers: ["record.json"] })).resolves.toMatchObject({ facts: built.facts });
    expect((await refusalOf(admitTemplateFolder(built.folder))).code).toBe("template_members_mismatch");
  });

  it("refuses to unpack into a folder that already exists, and leaves it as it was", async () => {
    const built = await build();
    await writeFile(path.join(dir, "kept"), "kept");
    await expect(readTemplateArchive(built.archive, dir)).rejects.toThrow("must not exist");
    expect(existsSync(path.join(dir, "kept"))).toBe(true);
  });
});

describe("the archive's own refusals", () => {
  it("refuses an archive past the transfer bound before reading it", async () => {
    // A complete, valid archive placed past a hole: only its size is wrong.
    const built = await build({ sparseBytes: TEMPLATE_ARCHIVE_MAX_BYTES + 1 });
    const refusal = await refusalOf(readTemplateArchive(built.archive, destination()));
    expect(refusal.code).toBe("template_archive_too_large");
    expect(existsSync(destination())).toBe(false);
  });

  it("refuses a file that is not an archive", async () => {
    const file = path.join(dir, "not-a-zip.zip");
    await writeFile(file, Buffer.alloc(4096, 7));
    const refusal = await refusalOf(readTemplateArchive(file, destination()));
    expect(refusal.code).toBe("template_malformed");
    expect(existsSync(destination())).toBe(false);
  });

  it("refuses an archive that unpacks past the upload cap, before a byte inflates", async () => {
    vi.stubEnv("DEZFIL_UPLOAD_MAX_MB", "1");
    // An honest member: the cap is what it passes, not a lying header.
    const built = await build({ edit: (files) => files.binaries.set("datasets/padding.bin", Buffer.alloc(1536 * 1024)) });
    const refusal = await refusalOf(readTemplateArchive(built.archive, destination()));
    expect(refusal.code).toBe("template_unpacked_too_large");
    expect(existsSync(destination())).toBe(false);
  });

  const archiveCases: [string, keyof typeof ARCHIVE_SEEDS, TemplateRefusalCode][] = [
    ["a member climbing out of its folder", "escapingEntry", "template_entry_escapes"],
    ["a member under a second root", "secondRoot", "template_malformed"],
    ["one member written twice", "duplicateMember", "template_malformed"],
    ["a declared unpacked size past the cap", "lyingUnpackedSize", "template_unpacked_too_large"],
    ["an encrypted member", "encryptedMember", "template_malformed"],
  ];
  it.each(archiveCases)("refuses %s", async (_what, seed, code) => {
    const built = await build({ zip: ARCHIVE_SEEDS[seed] });
    const refusal = await refusalOf(readTemplateArchive(built.archive, destination()));
    expect(refusal.code).toBe(code);
    expect(existsSync(destination())).toBe(false);
  });

  it("refuses a member whose bytes outgrow its directory entry, with nothing left behind", async () => {
    const built = await build({
      zip: (members) => members.map((m) =>
        m.name.endsWith("/maps/map.json") ? { ...m, declaredUncompressedSize: 16 } : m),
    });
    const refusal = await refusalOf(readTemplateArchive(built.archive, destination()));
    expect(refusal.code).toBe("template_malformed");
    expect(existsSync(destination())).toBe(false);
  });
});

describe("the first stage of the admission", () => {
  const documentCases: [string, keyof typeof SEEDS, TemplateRefusalCode, "map" | "workflow"][] = [
    ["a publication's token", "publicationToken", "template_forbidden", "map"],
    ["a live publication", "publishedMap", "template_forbidden", "map"],
    ["a pasted basemap address", "customBasemap", "template_forbidden", "map"],
    ["a connection", "connection", "template_forbidden", "map"],
    ["a setting", "setting", "template_forbidden", "map"],
    ["a template format version this server does not read", "staleFormatVersion", "template_format_unsupported", "map"],
    ["an export format version this server does not read", "laterExportVersion", "template_format_unsupported", "map"],
    ["facts missing a field", "factsWithoutPlace", "template_invalid", "map"],
    ["a tag outside the list", "unknownTag", "template_invalid", "map"],
    ["a widget naming a layer the map does not have", "strayWidget", "template_invalid", "map"],
    ["a layer whose style is not a style", "invalidStyle", "template_invalid", "map"],
    ["a legend order naming a layer twice", "invalidLegendOrder", "template_invalid", "map"],
    ["a camera past its bounds", "invalidViewport", "template_invalid", "map"],
    ["a picture that is not a PNG", "pictureNotPng", "template_invalid", "map"],
    ["a missing picture", "missingPicture", "template_members_mismatch", "map"],
    ["a picture past its bound", "oversizedPicture", "template_picture_too_large", "map"],
    ["a dataset the manifest names and the template lacks", "missingDataset", "template_members_mismatch", "map"],
    ["a member nothing names", "strayMember", "template_members_mismatch", "map"],
    ["a document that is not JSON", "mapNotJson", "template_malformed", "map"],
    ["a step reaching an outside service", "geocodingStep", "template_invalid", "workflow"],
    ["a step whose operation the catalogue does not know", "unknownOperation", "template_invalid", "workflow"],
    ["a step without its bundled result", "missingResult", "template_members_mismatch", "workflow"],
    ["two steps declaring one result", "duplicateOutput", "template_invalid", "workflow"],
    ["a layout note the canvas does not draw", "invalidLayoutNote", "template_invalid", "workflow"],
    ["a workflow example's facts listing no steps", "factsWithoutSteps", "template_invalid", "workflow"],
    ["a map template's facts listing a step", "mapFactsWithSteps", "template_invalid", "map"],
    ["a step in the facts reading what the template does not hold", "stepFactsReadUnknown", "template_invalid", "workflow"],
    ["the facts listing a step under another id", "stepFactsId", "template_invalid", "workflow"],
    ["the facts naming another operation for a step", "stepFactsOperation", "template_invalid", "workflow"],
    ["the facts naming another output for a step", "stepFactsOutput", "template_invalid", "workflow"],
    ["the facts listing fewer steps than the workflow", "stepFactsMissingStep", "template_invalid", "workflow"],
  ];

  it.each(documentCases)("refuses %s, from the archive and from the installed form", async (_what, seed, code, kind) => {
    const built = await build({ kind, edit: SEEDS[seed] });
    const fromArchive = await refusalOf(readTemplateArchive(built.archive, destination()));
    expect(fromArchive.code).toBe(code);
    expect(existsSync(destination())).toBe(false);
    const fromFolder = await refusalOf(admitTemplateFolder(built.folder));
    expect(fromFolder.code).toBe(code);
  });

  it("names what reaches an outside service, and why a template's step may not", async () => {
    const built = await build({ kind: "workflow", edit: SEEDS.geocodingStep });
    const refusal = await refusalOf(admitTemplateFolder(built.folder));
    expect(refusal.message).toMatch(/reaches an outside service/);
  });

  it("names the step whose facts the workflow does not hold, and what differs", async () => {
    const operation = await refusalOf(admitTemplateFolder((await build({ kind: "workflow", edit: SEEDS.stepFactsOperation })).folder));
    expect(operation.message).toBe('The facts list step 2 ("step-rings") as running sql_step; the workflow\'s step runs buffer.');
    const output = await refusalOf(admitTemplateFolder((await build({ kind: "workflow", edit: SEEDS.stepFactsOutput })).folder));
    expect(output.message).toBe('The facts list step 1 ("step-busy") as making "busiest_stations"; the workflow\'s step makes "busy_stations".');
    const count = await refusalOf(admitTemplateFolder((await build({ kind: "workflow", edit: SEEDS.stepFactsMissingStep })).folder));
    expect(count.message).toBe("The facts list 1 step; the workflow has 2.");
  });

  it("leaves what a step reads to the second stage, which reads it as a run does: facts saying other reads pass the first", async () => {
    for (const seed of ["stepFactsReadsSql", "stepFactsReadsDeclared"] as const) {
      const built = await build({ kind: "workflow", edit: SEEDS[seed] });
      await expect(admitTemplateFolder(built.folder)).resolves.toMatchObject({ facts: built.facts });
    }
  });

  it("names the forbidden field and what it carries", async () => {
    const built = await build({ edit: SEEDS.publicationToken });
    const refusal = await refusalOf(admitTemplateFolder(built.folder));
    expect(refusal.message).toBe('The document "maps/map.json" carries a publication (publishToken), which no template may hold.');
  });

  it("holds the map's rules against the document's own layers: a timeline on a layer without its time filter", async () => {
    const built = await build({
      edit: (files) => {
        files.documents.get("maps/map.json")!.timeline = { layerId: "layer-stations", field: "opened" };
      },
    });
    const refusal = await refusalOf(admitTemplateFolder(built.folder));
    expect(refusal.code).toBe("template_invalid");
    expect(refusal.message).toMatch(/needs a time filter on "opened"/);
  });

  it("admits the same timeline once the layer carries the filter it docks to", async () => {
    const built = await build({
      edit: (files) => {
        const map = files.documents.get("maps/map.json")!;
        (map.layers as Record<string, unknown>[])[0].filters = [{ field: "opened", kind: "timerange", min: null, max: null }];
        map.timeline = { layerId: "layer-stations", field: "opened" };
      },
    });
    const admitted = await admitTemplateFolder(built.folder);
    expect(admitted.map.timeline).toMatchObject({ layerId: "layer-stations", field: "opened" });
  });
});
