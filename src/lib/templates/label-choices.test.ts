import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import { installTemplateArchive } from "./install";
import * as shippedIndex from "./shipped-index";

/**
 * A template's labels, read as stored labels are: a template made before
 * labels carried their text and halo choices follows the map only with the
 * whole old starting paint and keeps its own paint otherwise; one made by
 * this version keeps the choices it carries. The same on the three roads a
 * template's map takes after the upgrade (its view, its installation from
 * an archive, and its copy into a project), and its files are never
 * rewritten. The shipped Rwanda template keeps its label's colours and its
 * bold.
 */

const ORIGIN = "http://instance.test";
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const OLD_HALO = { r: 12, g: 16, b: 24, a: 0.8 };
const INK = { r: 20, g: 30, b: 40, a: 1 };
// The light recipe, for a template on Auto, written out as its hex values.
const LIGHT = { color: { r: 0x24, g: 0x32, b: 0x30, a: 1 }, haloWidth: 1.5, haloColor: { r: 255, g: 255, b: 255, a: 1 } };

type Choice = "automatic" | "own";
/** Each label as the template's file holds it, and the choices it reads as. */
const FIXTURES: [string, Record<string, unknown>, Choice, Choice][] = [
  ["the complete old starting paint", { color: WHITE, haloWidth: 0, haloColor: OLD_HALO }, "automatic", "automatic"],
  ["white with a visible halo", { color: WHITE, haloWidth: 1, haloColor: OLD_HALO }, "own", "own"],
  ["text in another colour", { color: INK, haloWidth: 0, haloColor: OLD_HALO }, "own", "own"],
  ["white that is not opaque", { color: { ...WHITE, a: 0.6 }, haloWidth: 0, haloColor: OLD_HALO }, "own", "own"],
  ["a width-0 halo in another colour", { color: WHITE, haloWidth: 0, haloColor: INK }, "own", "own"],
  // Made by this version: the choices it carries are kept as they are.
  ["the old starting paint, chosen as its own", { textPaint: "own", haloPaint: "own", color: WHITE, haloWidth: 0, haloColor: OLD_HALO }, "own", "own"],
  ["automatic text beside its own halo", { textPaint: "automatic", haloPaint: "own", color: WHITE, haloWidth: 2, haloColor: INK }, "automatic", "own"],
];
const part = (i: number) => `layer-f${i}`;

/** The fixture template with one stations layer per label. */
const labelled = (id: string) => (dir: string) => buildTemplate(dir, {
  id,
  edit: (files) => {
    const map = files.documents.get("maps/map.json")!;
    const layers = map.layers as Record<string, unknown>[];
    const stations = layers.find((layer) => layer.id === "layer-stations")!;
    FIXTURES.forEach(([name, label], i) => layers.push({
      ...stations, id: part(i), name, ordinal: layers.length,
      style: { ...(stations.style as object), label: { attribute: "name", size: 11, weight: "bold", ...label } },
    }));
    map.legendOrder = null;
  },
});

let built: string;
let shippedOne: BuiltTemplate;
let installedOne: BuiltTemplate;
beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-labels-"));
  shippedOne = await labelled("labels-shipped")(path.join(built, "shipped"));
  installedOne = await labelled("labels-installed")(path.join(built, "installed"));
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;
beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-labels-run-"));
});
afterEach(async () => {
  resetQueryInstance();
  f.close();
  await rm(dir, { recursive: true, force: true });
});

async function call(method: string, route: string, body?: unknown) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method,
    headers: { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })));
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBeLessThan(300);
  return json;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function hashes(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[path.relative(folder, path.join(entry.parentPath, entry.name))] = sha(await readFile(path.join(entry.parentPath, entry.name)));
  }
  return out;
}

interface Layer { id: string; name: string; style: { label?: Record<string, unknown> } }

/** Every fixture layer's label in a map answer, each as its rule says. */
function expectFixtures(layers: Layer[], layerId: (i: number) => string) {
  FIXTURES.forEach(([name, label, text, halo], i) => {
    const read = layers.find((layer) => layer.id === layerId(i))!.style.label!;
    expect([read.textPaint, read.haloPaint], name).toEqual([text, halo]);
    expect([read.size, read.weight], name).toEqual([11, "bold"]);
    expect(read.color, name).toEqual(text === "own" ? label.color : LIGHT.color);
    expect([read.haloWidth, read.haloColor], name).toEqual(halo === "own" ? [label.haloWidth, label.haloColor] : [LIGHT.haloWidth, LIGHT.haloColor]);
  });
}

/** The view, layer by layer and as the map, then a copy into a project. */
async function viewAndCopy(template: BuiltTemplate, folder: string) {
  const id = template.facts.id;
  const before = await hashes(folder);
  const mapId = `template.${id}.1.map`;
  const viewed = await call("GET", `/api/maps/${mapId}`);
  const viewId = (i: number) => `template.${id}.1.layer.${part(i)}`;
  expectFixtures(viewed.layers, viewId);
  for (let i = 0; i < FIXTURES.length; i++) {
    expect((await call("GET", `/api/layers/${viewId(i)}`)).style.label).toEqual(viewed.layers.find((l: Layer) => l.id === viewId(i)).style.label);
  }
  const copied = await call("POST", `/api/templates/${id}/copy`, {});
  const map = await call("GET", `/api/maps/${copied.members.maps[0].id}`);
  const byName = (i: number) => map.layers.find((layer: Layer) => layer.name === FIXTURES[i][0]).id;
  expectFixtures(map.layers, byName);
  // The copy stores both choices; the template's files are as they were.
  for (let i = 0; i < FIXTURES.length; i++) {
    const row = f.db.prepare("SELECT style FROM layers WHERE id = ?").get(byName(i)) as { style: string };
    expect(JSON.parse(row.style).label).toMatchObject({ textPaint: FIXTURES[i][2], haloPaint: FIXTURES[i][3] });
  }
  expect(await hashes(folder)).toEqual(before);
}

describe("a template's labels after the upgrade", () => {
  it("read as the rule says when viewed and copied from the image's shipped folder", async () => {
    const shipped = await writeShippedFolder(path.join(dir, "shipped"), [shippedOne]);
    vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(shipped);
    await viewAndCopy(shippedOne, path.join(shipped, "labels-shipped", "1"));
  });

  it("read as the rule says once installed from its archive, viewed and copied", async () => {
    vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), []));
    const scratch = path.join(dir, "install");
    await mkdir(scratch);
    const expected = { id: installedOne.facts.id, version: installedOne.facts.version, size: installedOne.size, sha256: installedOne.sha256 };
    await installTemplateArchive(testAccountScope(f.db, "member"), scratch, installedOne.archive, expected, { kind: "catalogue", origin: "https://catalogue.example" });
    await viewAndCopy(installedOne, path.join(dataDir(), "templates", "labels-installed", "1"));
  });
});

describe("the shipped Rwanda template", () => {
  it("keeps its district label's own colours and its bold", async () => {
    const map = await call("GET", "/api/maps/template.rwanda-health-access.4.map");
    const labels = map.layers.map((layer: Layer) => layer.style.label).filter(Boolean);
    expect(labels).toEqual([{
      attribute: "label", size: 9, weight: "bold", density: 0.75, priorityField: "share_beyond_5km",
      textPaint: "own", color: WHITE, haloPaint: "own", haloWidth: 1, haloColor: { r: 29, g: 31, b: 36, a: 0.85 },
    }]);
  });
});
