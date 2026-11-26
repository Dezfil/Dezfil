import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { testClient } from "@/lib/mcp/test-client";
import { buildTools } from "@/lib/tools/tools";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { journeyClient } from "../../scripts/mcp-journey-core.mjs";

/**
 * A label's text and halo choices through both roads an agent has, the
 * HTTP API and its MCP tools: every rule a write follows, an answer read
 * and written back, the resets, and every refusal leaving the map exactly
 * as it was. Each successful answer is held to the schema the description
 * publishes for it.
 */

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;

beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-label-choices-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, async (url: string) =>
    (await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`))).json());
});
afterAll(async () => {
  await client?.close();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const SQL = "SELECT 'Harbour' AS name, ST_Point(13.4, 52.5) AS geometry";

// The recipes, written out as the hex values they name.
const LIGHT = { color: { r: 0x24, g: 0x32, b: 0x30, a: 1 }, haloWidth: 1.5, haloColor: { r: 255, g: 255, b: 255, a: 1 } };
const DARK = { color: { r: 0xe9, g: 0xec, b: 0xf3, a: 1 }, haloWidth: 1.5, haloColor: { r: 0x0b, g: 0x0e, b: 0x14, a: 1 } };
const OWN = { r: 200, g: 40, b: 40, a: 1 };
const OLD = { color: { r: 255, g: 255, b: 255, a: 1 }, haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } };

const INCOMPLETE =
  "label.haloWidth and label.haloColor go together: send both for a halo of the label's own, or neither for one that follows the map.";

interface Answer {
  id: string;
  mapId: string;
  editRevision: string;
  style: LayerStyle;
}

const tool = (name: string) => buildTools().find((t) => t.name === name)!;
async function answersSchema(name: string, body: unknown): Promise<void> {
  const validator = fromJsonSchema(tool(name).rawOutputSchema! as Parameters<typeof fromJsonSchema>[0]);
  expect((await validator["~standard"].validate(body)).issues, name).toBeUndefined();
}

async function http(method: string, url: string, body?: unknown, revision?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (revision) headers["X-Edit-Revision"] = revision;
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json() };
}

/** What a refusal must leave untouched: the map, its layers and its revision. */
const mapState = async (mapId: string) => (await http("GET", `/api/maps/${mapId}`)).body;

interface Road {
  name: string;
  map(basemap?: string): Promise<{ id: string }>;
  create(mapId: string, style: unknown): Promise<Answer>;
  update(layer: { id: string; mapId: string }, style: unknown): Promise<Answer>;
  read(layer: { id: string }): Promise<Answer>;
  refuseCreate(mapId: string, style: unknown, message: string | null): Promise<void>;
  refuseUpdate(layer: { id: string; mapId: string }, style: unknown, message: string | null): Promise<void>;
}

const revisionOf = async (mapId: string) => (await mapState(mapId)).editRevision as string;

const HTTP: Road = {
  name: "HTTP",
  async map(basemap) {
    const created = await http("POST", "/api/maps", { name: "Labels" });
    expect(created.status).toBe(201);
    if (basemap) expect((await http("PATCH", `/api/maps/${created.body.id}`, { basemap }, created.body.editRevision)).status).toBe(200);
    return created.body;
  },
  async create(mapId, style) {
    const answer = await http("POST", `/api/maps/${mapId}/layers`, { name: "Places", sql: SQL, style }, await revisionOf(mapId));
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    await answersSchema("create_layer", answer.body);
    return answer.body;
  },
  async update(layer, style) {
    const answer = await http("PATCH", `/api/layers/${layer.id}`, { style }, await revisionOf(layer.mapId));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    await answersSchema("update_layer", answer.body);
    return answer.body;
  },
  async read(layer) {
    const answer = await http("GET", `/api/layers/${layer.id}`);
    expect(answer.status).toBe(200);
    await answersSchema("get_layer", answer.body);
    return answer.body;
  },
  async refuseCreate(mapId, style, message) {
    const before = await mapState(mapId);
    const answer = await http("POST", `/api/maps/${mapId}/layers`, { name: "Places", sql: SQL, style }, before.editRevision);
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe("invalid_request");
    if (message) expect(answer.body.error.message).toBe(`The style is not valid: ${message}`);
    expect(await mapState(mapId)).toEqual(before);
  },
  async refuseUpdate(layer, style, message) {
    const before = await mapState(layer.mapId);
    const answer = await http("PATCH", `/api/layers/${layer.id}`, { style }, before.editRevision);
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe("invalid_request");
    if (message) expect(answer.body.error.message).toBe(`The style is not valid: ${message}`);
    expect(await mapState(layer.mapId)).toEqual(before);
  },
};

/** Through the generated tools, whose client holds every answer to the
 * published output schema as well. */
async function mcpAnswers(name: string, body: unknown): Promise<void> {
  const validator = fromJsonSchema(tool(name).outputSchema! as Parameters<typeof fromJsonSchema>[0]);
  expect((await validator["~standard"].validate({ result: body, history: null })).issues, name).toBeUndefined();
}

const MCP: Road = {
  name: "MCP",
  async map(basemap) {
    const created = await journey.call("create_map", { name: "Labels" });
    if (basemap) await journey.call("update_map", { id: created.id, basemap, expected_revision: created.editRevision });
    return created;
  },
  async create(mapId, style) {
    const answer = await journey.call("create_layer", { id: mapId, name: "Places", sql: SQL, style, expected_revision: await revisionOf(mapId) });
    await mcpAnswers("create_layer", answer);
    return answer;
  },
  async update(layer, style) {
    const answer = await journey.call("update_layer", { id: layer.id, style, expected_revision: await revisionOf(layer.mapId) });
    await mcpAnswers("update_layer", answer);
    return answer;
  },
  async read(layer) {
    const answer = await journey.call("get_layer", { id: layer.id });
    await mcpAnswers("get_layer", answer);
    return answer;
  },
  async refuseCreate(mapId, style) {
    const before = await mapState(mapId);
    await journey.call("create_layer", { id: mapId, name: "Places", sql: SQL, style, expected_revision: before.editRevision }, "invalid_request");
    expect(await mapState(mapId)).toEqual(before);
  },
  async refuseUpdate(layer, style) {
    const before = await mapState(layer.mapId);
    await journey.call("update_layer", { id: layer.id, style, expected_revision: before.editRevision }, "invalid_request");
    expect(await mapState(layer.mapId)).toEqual(before);
  },
};

const labelled = (label: Record<string, unknown>) => ({ ...defaultStyle("POINT"), label: { attribute: "name", size: 12, ...label } });
const paintOf = (style: LayerStyle) => {
  const { textPaint, color, haloPaint, haloWidth, haloColor } = style.label!;
  return { textPaint, color, haloPaint, haloWidth, haloColor };
};
const auto = (recipe: typeof LIGHT) => ({ textPaint: "automatic", haloPaint: "automatic", ...recipe });

// What a write sends, and the paint it stores, on a map on Light.
const WRITES: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["no paint at all follows the map, text and halo", {}, auto(LIGHT)],
  ["a colour without a choice is the text's own", { color: OWN },
    { textPaint: "own", color: OWN, haloPaint: "automatic", haloWidth: LIGHT.haloWidth, haloColor: LIGHT.haloColor }],
  ["a halo width and colour without a choice are the halo's own", { haloWidth: 0.5, haloColor: OWN },
    { textPaint: "automatic", color: LIGHT.color, haloPaint: "own", haloWidth: 0.5, haloColor: OWN }],
  ["an explicit automatic overrides the valid values beside it, the halo width included",
    { textPaint: "automatic", color: OWN, haloPaint: "automatic", haloWidth: 3, haloColor: OWN }, auto(LIGHT)],
  ["an explicit automatic halo takes one valid value beside it", { haloPaint: "automatic", haloWidth: 2 }, auto(LIGHT)],
  ["an explicit own keeps its values", { textPaint: "own", color: OWN, haloPaint: "own", haloWidth: 0.5, haloColor: OWN },
    { textPaint: "own", color: OWN, haloPaint: "own", haloWidth: 0.5, haloColor: OWN }],
  ["the old starting paint without choices is the label's own", OLD, { textPaint: "own", haloPaint: "own", ...OLD }],
];

// What a write may not send. The message is the HTTP road's; the tools
// refuse the same writes as invalid requests too, an unknown choice already
// at their own input schema.
const REFUSALS: [string, Record<string, unknown>, string][] = [
  ["a halo width alone", { haloWidth: 2 }, INCOMPLETE],
  ["a halo colour alone", { haloColor: OWN }, INCOMPLETE],
  ["an own halo missing its colour", { haloPaint: "own", haloWidth: 1 }, INCOMPLETE],
  ["an own text missing its colour", { textPaint: "own" }, "label needs a valid color."],
  ["an unknown text choice", { textPaint: "auto" }, 'label.textPaint accepts "automatic" or "own".'],
  ["an unknown halo choice", { haloPaint: "custom", haloWidth: 1, haloColor: OWN }, 'label.haloPaint accepts "automatic" or "own".'],
  ["an invalid colour beside an explicit automatic", { textPaint: "automatic", color: { r: 999, g: 0, b: 0, a: 1 } }, "label needs a valid color."],
  ["an invalid halo width beside an explicit automatic", { haloPaint: "automatic", haloWidth: 9 },
    "label.haloWidth must be a number, 0 to 3 (0 = no halo)."],
  ["a label without its size", { size: undefined }, "label.size must be a number of pixels, 1 to 72."],
];

describe.each([HTTP, MCP])("a label's choices over $name", (road) => {
  describe("on creation", () => {
    it.each(WRITES)("%s", async (_name, sent, stored) => {
      const map = await road.map();
      const created = await road.create(map.id, labelled(sent));
      expect(paintOf(created.style)).toEqual(stored);
      expect(paintOf((await road.read(created)).style)).toEqual(stored);
    });

    it.each(REFUSALS)("refuses %s, and the map is unchanged", async (_name, sent, message) => {
      const map = await road.map();
      await road.refuseCreate(map.id, labelled(sent), message);
    });

    it("still means no labels when no label is sent", async () => {
      const map = await road.map();
      const created = await road.create(map.id, defaultStyle("POINT"));
      expect(created.style.label).toBeUndefined();
    });
  });

  describe("on update", () => {
    it.each(WRITES)("%s", async (_name, sent, stored) => {
      const map = await road.map();
      const layer = await road.create(map.id, defaultStyle("POINT"));
      const updated = await road.update(layer, labelled(sent));
      expect(paintOf(updated.style)).toEqual(stored);
      expect(paintOf((await road.read(layer)).style)).toEqual(stored);
    });

    it.each(REFUSALS)("refuses %s, and the map is unchanged", async (_name, sent, message) => {
      const map = await road.map();
      const layer = await road.create(map.id, labelled({ textPaint: "own", color: OWN }));
      await road.refuseUpdate(layer, labelled(sent), message);
    });
  });

  describe("an answer written back", () => {
    it.each([
      ["both automatic", {}],
      ["the text its own, the halo automatic", { color: OWN }],
      ["both its own", { color: OWN, haloWidth: 2, haloColor: OWN }],
    ])("keeps its choices, %s, with only the size changed", async (_name, sent) => {
      const map = await road.map("dark");
      const created = await road.create(map.id, labelled(sent));
      const read = await road.read(created);
      const echoed = await road.update(created, { ...read.style, label: { ...read.style.label, size: 15 } });
      expect(echoed.style.label).toEqual({ ...read.style.label, size: 15 });
      expect((await road.read(created)).style.label).toEqual({ ...read.style.label, size: 15 });
    });
  });

  describe("the resets", () => {
    it("return the text, then the halo, to automatic, each leaving the other alone", async () => {
      const map = await road.map("dark");
      const created = await road.create(map.id, labelled({ color: OWN, haloWidth: 2, haloColor: OWN }));
      const text = await road.update(created, { ...created.style, label: { ...created.style.label, textPaint: "automatic" } });
      expect(paintOf(text.style)).toEqual({ textPaint: "automatic", color: DARK.color, haloPaint: "own", haloWidth: 2, haloColor: OWN });
      const halo = await road.update(created, { ...text.style, label: { ...text.style.label, haloPaint: "automatic" } });
      expect(paintOf(halo.style)).toEqual(auto(DARK));
      const back = await road.update(created, { ...halo.style, label: { ...halo.style.label, textPaint: "own", color: OWN } });
      expect(paintOf(back.style)).toEqual({ textPaint: "own", color: OWN, haloPaint: "automatic", haloWidth: DARK.haloWidth, haloColor: DARK.haloColor });
    });
  });
});
