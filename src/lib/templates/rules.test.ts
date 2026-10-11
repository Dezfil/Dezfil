import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountScope } from "@/lib/auth/scope";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { readTemplateArchive } from "./archive";
import { SHIPPED_TEMPLATES_MAX_BYTES, TEMPLATE_ARCHIVE_MAX_BYTES, type TemplateFacts } from "./format";
import { installTemplateArchive } from "./install";
import { NOTICE_NONE_LINE, noticeProblems } from "./notice";
import { TemplateRefusal, type TemplateRefusalCode } from "./refusals";
import { checkShippedSet, shippedTemplatesDir } from "./shipped";
import {
  FIXTURE_SOURCES,
  SEEDS,
  buildTemplate,
  installFixture,
  writeShippedFolder,
  type TemplateFixtureOptions,
} from "../../../test-support/templates/builder";

/**
 * The rules every template must meet, held over the shipped set and over
 * the fixture: every shipped version passes, and a fixture failing each
 * rule a template's documents, data and archive can break fails. The check
 * over the shipped set is shown to bite by pointing it at a folder holding
 * a failing template. NOTICE is held against the shipped set both ways.
 */

let dir: string;
let db: Database;
let scope: AccountScope;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-rules-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  resetQueryInstance();
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  scope = testAccountScope(db, "rules");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetQueryInstance();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Every file under a folder, relative to it; folders alone count for
 * nothing (the engine makes its own on start). */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name))).sort();
}

let built = 0;
const build = (options: TemplateFixtureOptions = {}) => buildTemplate(path.join(dir, `built-${built++}`), options);

/** The rules over one template as a catalogue serves it: its archive
 * installed by the install's own road, both stages of the admission and
 * the upload's reader. The code of the rule it fails, or null when it
 * passes; a template that fails leaves nothing in the data folder. */
async function ruleFailed(options: TemplateFixtureOptions): Promise<TemplateRefusalCode | null> {
  const template = await build(options);
  const scratch = path.join(dir, `install-${built++}`);
  await mkdir(scratch);
  try {
    const expected = { id: template.facts.id, version: template.facts.version, size: template.size, sha256: template.sha256 };
    await installTemplateArchive(scope, scratch, template.archive, expected, { kind: "shipped" });
    return null;
  } catch (error) {
    if (error instanceof TemplateRefusal) {
      expect(await filesUnder(dataDir())).toEqual([]);
      return error.code;
    }
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(dataDir(), { recursive: true, force: true });
  }
}

describe("the shipped set", () => {
  it("passes every rule: each listed version installed whole, nothing unlisted, within the shipped bound", async () => {
    const check = await checkShippedSet(scope, shippedTemplatesDir());
    expect(check.problems).toEqual([]);
    expect(check.bytes).toBeLessThanOrEqual(SHIPPED_TEMPLATES_MAX_BYTES);
  });

  it("is listed in NOTICE, every shipped version with its sources, licences and credits, and nothing else", async () => {
    const check = await checkShippedSet(scope, shippedTemplatesDir());
    const notice = await readFile(path.join(process.cwd(), "NOTICE"), "utf8");
    expect(noticeProblems(notice, check.versions.map((v) => v.admitted.facts))).toEqual([]);
  });

  it("bites on a folder holding a template that fails a rule, naming it", async () => {
    const good = await build();
    const failing = await build({ kind: "workflow", edit: SEEDS.nonCommercialLicence });
    const folder = await writeShippedFolder(path.join(dir, "shipped"), [good, failing]);
    const check = await checkShippedSet(scope, folder);
    expect(check.versions.map((v) => v.admitted.facts.id)).toEqual(["harbour-stations"]);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatch(/^busy-stations version 1: template_licence_refused: /);
  });

  it("bites on a folder holding a template whose layer names a dataset outside it, in the second stage", async () => {
    const folder = await writeShippedFolder(path.join(dir, "shipped"), [await build(), await build({ id: "outside", edit: SEEDS.layerReferenceOutside })]);
    const check = await checkShippedSet(scope, folder);
    expect(check.versions.map((v) => v.admitted.facts.id)).toEqual(["harbour-stations"]);
    expect(check.problems).toEqual([
      'outside version 1: template_reference_outside: The map\'s layer 1 ("Stations") names "roads", which is not a dataset of the template or a result of an earlier step.',
    ]);
    expect(await filesUnder(dataDir())).toEqual([]);
  });

  it("passes a folder holding passing templates of both kinds", async () => {
    const folder = await writeShippedFolder(path.join(dir, "shipped"), [await build(), await build({ kind: "workflow" })]);
    const check = await checkShippedSet(scope, folder);
    expect(check.problems).toEqual([]);
    expect(check.versions.map((v) => v.admitted.facts.id)).toEqual(["harbour-stations", "busy-stations"]);
  });

  it("refuses a folder holding a version its index does not list", async () => {
    const folder = await writeShippedFolder(path.join(dir, "shipped"), [await build()]);
    await installFixture(await build({ id: "unlisted" }), path.join(folder, "unlisted", "1"));
    expect((await checkShippedSet(scope, folder)).problems).toEqual([
      'The shipped folder holds "unlisted", which its index does not list.',
    ]);
  });

  it("refuses a member changed after its version was recorded", async () => {
    const folder = await writeShippedFolder(path.join(dir, "shipped"), [await build()]);
    await writeFile(path.join(folder, "harbour-stations", "1", "pictures", "dark.png"), (await build()).files.binaries.get("pictures/light.png")!);
    expect((await checkShippedSet(scope, folder)).problems).toEqual([
      'harbour-stations version 1: template_record_mismatch: The member "pictures/dark.png" differs from its record.',
    ]);
  });

  it("refuses a shipped set past its bound together, the bound 50 MB", async () => {
    expect(SHIPPED_TEMPLATES_MAX_BYTES).toBe(50 * 1024 * 1024);
    const folder = await writeShippedFolder(path.join(dir, "shipped"), [await build(), await build({ kind: "workflow" })]);
    const { bytes } = await checkShippedSet(scope, folder);
    expect((await checkShippedSet(scope, folder, { maxBytes: bytes })).problems).toEqual([]);
    const over = await checkShippedSet(scope, folder, { maxBytes: bytes - 1 });
    expect(over.problems).toEqual([
      `The shipped templates together are ${(bytes / (1024 * 1024)).toFixed(1)} MB; the image carries at most ${((bytes - 1) / (1024 * 1024)).toFixed(1)} MB of them.`,
    ]);
  });
});

describe("the rules every template must meet", () => {
  it("the fixture passes them, as a map template and as a workflow example", async () => {
    expect(await ruleFailed({})).toBeNull();
    expect(await ruleFailed({ kind: "workflow" })).toBeNull();
  });

  it.each<[string, TemplateFixtureOptions, TemplateRefusalCode]>([
    ["a non-commercial licence", { edit: SEEDS.nonCommercialLicence }, "template_licence_refused"],
    ["a credit note missing a source", { edit: SEEDS.missingCredit }, "template_credit_missing"],
    ["an archive over 150 MB", { sparseBytes: TEMPLATE_ARCHIVE_MAX_BYTES + 1 }, "template_archive_too_large"],
    ["a geocoding step", { kind: "workflow", edit: SEEDS.geocodingStep }, "template_invalid"],
    ["a publication token", { edit: SEEDS.publicationToken }, "template_forbidden"],
    ["a stale format version", { edit: SEEDS.staleFormatVersion }, "template_format_unsupported"],
    ["a missing picture", { edit: SEEDS.missingPicture }, "template_members_mismatch"],
    ["an output without its result", { kind: "workflow", edit: SEEDS.missingResult }, "template_members_mismatch"],
    ["a layer naming a dataset outside the template", { edit: SEEDS.layerReferenceOutside }, "template_reference_outside"],
    ["a step reading a dataset outside the template", { kind: "workflow", edit: SEEDS.stepReferenceOutside }, "template_reference_outside"],
  ])("a template with %s fails them", async (_what, options, code) => {
    expect(await ruleFailed(options)).toBe(code);
  });

  it("a template unpacking over the instance's upload cap fails them", async () => {
    vi.stubEnv("DEZFIL_UPLOAD_MAX_MB", "1");
    expect(await ruleFailed({ edit: (files) => files.binaries.set("datasets/padding.bin", Buffer.alloc(1536 * 1024)) }))
      .toBe("template_unpacked_too_large");
  });

  it("names the licence that does not allow the data to be redistributed", async () => {
    const template = await build({ edit: SEEDS.nonCommercialLicence });
    await expect(readTemplateArchive(template.archive, path.join(dir, "read"))).rejects.toThrow(
      `The source "${FIXTURE_SOURCES[0].name}" is under CC-BY-NC-4.0, which is not a licence that allows the data to be redistributed.`,
    );
  });

  it("names the source the credit note leaves out", async () => {
    const template = await build({ edit: SEEDS.missingCredit });
    await expect(readTemplateArchive(template.archive, path.join(dir, "read"))).rejects.toThrow(
      `The map's credit note does not name the source "${FIXTURE_SOURCES[1].name}" with its licence and credit text.`,
    );
  });

  it("refuses a credit that only a hidden note carries", async () => {
    const code = await ruleFailed({
      edit: (files) => {
        const note = (files.documents.get("maps/map.json")!.widgets as Record<string, unknown>[]).find((w) => w.type === "note")!;
        note.visible = false;
      },
    });
    expect(code).toBe("template_credit_missing");
  });
});

describe("NOTICE against the shipped set", () => {
  const facts = (over: Partial<TemplateFacts> = {}): TemplateFacts => ({
    formatVersion: 1, id: "harbour-stations", version: 2, kind: "map", title: "Harbour stations",
    question: "Where?", place: "Example City", tags: ["First map"], dataDate: "2024",
    sources: FIXTURE_SOURCES.map((s) => ({ ...s })),
    howMade: { question: "Q", datasets: [], styling: ["S"] },
    pictures: { light: "pictures/light.png", dark: "pictures/dark.png" },
    ...over,
  });
  const section = (body: string) =>
    `Preamble\n\nShipped templates\n-----------------\n\nWords.\n\n${body}\n\nNext section\n------------\n\n- not an entry\n`;
  const listed = [
    `- harbour-stations version 2 ("Harbour stations"):`,
    ...FIXTURE_SOURCES.map((s) => `  - ${s.name}, ${s.licence}: ${s.credit}`),
  ].join("\n");

  it("holds when nothing ships and the section says so, and when what ships is listed", () => {
    expect(noticeProblems(section(NOTICE_NONE_LINE), [])).toEqual([]);
    expect(noticeProblems(section(listed), [facts()])).toEqual([]);
  });

  it("fails each seeded drift", () => {
    expect(noticeProblems("No section here.\n", [])).toEqual(['NOTICE has no "Shipped templates" section.']);
    expect(noticeProblems(section("Nothing said."), [])).toEqual([`NOTICE's shipped templates section must say "${NOTICE_NONE_LINE}" while none ships.`]);
    expect(noticeProblems(section(NOTICE_NONE_LINE), [facts()])).toEqual([
      "NOTICE's shipped templates section says none ships, and 1 do.",
      "NOTICE does not list the shipped template harbour-stations version 2.",
    ]);
    expect(noticeProblems(section(listed), [])).toEqual([
      `NOTICE's shipped templates section must say "${NOTICE_NONE_LINE}" while none ships.`,
      "NOTICE lists harbour-stations version 2, which does not ship.",
    ]);
    expect(noticeProblems(section(listed.replace("CC-BY-4.0", "CC-BY-NC-4.0")), [facts()])).toEqual([
      "NOTICE's sources for harbour-stations version 2 are not its sources with their licences and credits.",
    ]);
    expect(noticeProblems(section(listed), [facts({ version: 3 })])).toEqual([
      "NOTICE does not list the shipped template harbour-stations version 3.",
      "NOTICE lists harbour-stations version 2, which does not ship.",
    ]);
  });
});
