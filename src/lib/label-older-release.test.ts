import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import JSZip from "jszip";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { createProject } from "@/lib/metadata/owned-projects";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";
import { labelProblem as releasedLabelProblem } from "../../test-support/released-label-check";

/**
 * A project export, the form a template is made from, read by the label
 * check an earlier release holds. That release reads every label's
 * `color`, `haloWidth` and `haloColor` and refuses a label without them,
 * so each label this version writes out passes it whatever its choices:
 * automatic or own text, automatic or own halo, on a light and a dark
 * basemap, and a label stored before the choices existed. The same label
 * with one of its concrete values taken away fails it.
 */

let dir: string;
beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-label-older-release-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
});
afterAll(async () => {
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const SQL = "SELECT 'Harbour' AS name, ST_Point(13.4, 52.5) AS geometry";
const INK = { r: 200, g: 40, b: 40, a: 0.8 };
const RIM = { r: 10, g: 60, b: 90, a: 0.5 };

/** Each label as a write sends it, and the choices it is stored with. */
const LABELS: [string, Record<string, unknown>, string, string][] = [
  ["Both automatic", {}, "automatic", "automatic"],
  ["Both its own", { color: INK, haloWidth: 2, haloColor: RIM }, "own", "own"],
  ["Automatic text, own halo", { textPaint: "automatic", haloPaint: "own", haloWidth: 2, haloColor: RIM }, "automatic", "own"],
  ["Own text, automatic halo", { color: INK }, "own", "automatic"],
];

async function http(method: string, url: string, body?: unknown, revision?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (revision) headers["X-Edit-Revision"] = revision;
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  expect(response.status, url).toBeLessThan(300);
  return response;
}
const json = async (method: string, url: string, body?: unknown, revision?: string) => (await http(method, url, body, revision)).json();
const revision = (mapId: string) => readDocumentRevision({ kind: "map", id: mapId })!.editRevision!;

/** A map on the basemap given, with one layer per label above and one
 * whose stored row holds the whole old starting paint, as an earlier
 * release left it. */
async function labelledMap(project: string, name: string, basemap: string) {
  const map = await json("POST", "/api/maps", { name, projectId: project });
  await json("PATCH", `/api/maps/${map.id}`, { basemap }, revision(map.id));
  for (const [layer, paint] of LABELS) {
    const style = { ...defaultStyle("POINT"), label: { attribute: "name", size: 12, ...paint } };
    await json("POST", `/api/maps/${map.id}/layers`, { name: layer, sql: SQL, style }, revision(map.id));
  }
  const earlier = await json("POST", `/api/maps/${map.id}/layers`, { name: "Earlier", sql: SQL }, revision(map.id));
  const old = { attribute: "name", size: 12, color: { r: 255, g: 255, b: 255, a: 1 }, haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } };
  metadataDb().prepare("UPDATE layers SET style = ? WHERE id = ?").run(JSON.stringify({ ...defaultStyle("POINT"), label: old }), earlier.id);
  return map.id as string;
}

interface Layer { name: string; style: { label?: Record<string, unknown> } }

let labels: Map<string, Record<string, unknown>>;

beforeAll(async () => {
  const project = createProject(testAccountScope(), { name: "Older release" }).id;
  const maps = [await labelledMap(project, "On light", "light"), await labelledMap(project, "On dark", "dark")];
  const exported = await JSZip.loadAsync(Buffer.from(await (await http("POST", `/api/projects/${project}/export`, { file: "p", maps })).arrayBuffer()));
  labels = new Map();
  for (const file of exported.file(/^p\.dezfil\/maps\/[^/]+\.json$/)) {
    const document = JSON.parse(await file.async("string")) as { name: string; layers: Layer[] };
    for (const layer of document.layers) if (layer.style.label) labels.set(`${document.name} / ${layer.name}`, layer.style.label);
  }
});

describe("a project export read by an earlier release's label check", () => {
  it("passes for every label, whatever its choices", () => {
    expect(labels.size).toBe(2 * (LABELS.length + 1));
    for (const [where, label] of labels) expect(releasedLabelProblem(label), where).toBeNull();
  });

  it("holds every kind of choice, so the check is not passed vacuously", () => {
    for (const map of ["On light", "On dark"]) {
      for (const [layer, , text, halo] of LABELS) {
        expect([labels.get(`${map} / ${layer}`)!.textPaint, labels.get(`${map} / ${layer}`)!.haloPaint], `${map} / ${layer}`).toEqual([text, halo]);
      }
      expect(labels.get(`${map} / Earlier`)).toMatchObject({ textPaint: "automatic", haloPaint: "automatic" });
    }
  });

  it("fails for the same label with one concrete value taken away", () => {
    const label = labels.get("On dark / Both automatic")!;
    for (const [part, refusal] of [
      ["color", "label needs a valid color."],
      ["haloColor", "label.haloColor must be a valid color."],
      ["haloWidth", "label.haloWidth must be a number, 0 to 3 (0 = no halo)."],
    ] as const) {
      const taken = { ...label };
      delete taken[part];
      expect(releasedLabelProblem(taken), part).toBe(refusal);
    }
  });
});
