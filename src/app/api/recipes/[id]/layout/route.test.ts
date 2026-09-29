import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { POST as createRecipeRoute } from "../../route";
import { DELETE as deleteRecipeRoute, GET as readRecipe } from "../route";
import { POST as addStep } from "../steps/route";
import { DELETE as removeStep } from "../steps/[stepId]/route";
import { POST as runStep } from "../steps/[stepId]/run/route";
import { POST as duplicateRecipeRoute } from "../duplicate/route";
import { GET as readLayout, PUT as putLayout } from "./route";

/**
 * The layout document's surface, driven through its handlers: the empty
 * document, the round trip, the dropped unknown node, refusals that store
 * nothing, the last-edited rule, and what a read says after a node goes.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  await boundedEvaluation(async () => undefined);
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;
const body = async (r: Response) => (await r.json()) as Json;
const req = (method: string, payload?: unknown, raw?: string) =>
  new Request("http://test/api/recipes/x/layout", {
    method,
    body: raw ?? (payload === undefined ? undefined : JSON.stringify(payload)),
  });
const P = (id: string) => ({ params: Promise.resolve({ id }) });

async function newRecipe(name = "R"): Promise<string> {
  const response = await createRecipeRoute(testAccountRequest(req("POST", { name })));
  expect(response.status).toBe(201);
  return ((await body(response)).recipe as Json).id as string;
}

async function newStep(recipeId: string, sql: string, name: string): Promise<string> {
  const response = await addStep(
    testAccountRequest(req("POST", { operation: "sql_step", parameters: { sql, name } })),
    P(recipeId),
  );
  expect(response.status).toBe(201);
  return ((await body(response)).step as Json).id as string;
}

const recipe = async (id: string) =>
  (await body(await readRecipe(testAccountRequest(req("GET")), P(id)))).recipe as Json;
const layout = async (id: string) => {
  const response = await readLayout(testAccountRequest(req("GET")), P(id));
  expect(response.status).toBe(200);
  return (await body(response)).layout as Json;
};
const write = async (id: string, doc: unknown) => putLayout(testAccountRequest(req("PUT", doc)), P(id));

const EMPTY = { steps: {}, sources: {}, notes: [], updatedAt: null };
const note = (id: string, color = "yellow") => ({
  id, x: 20, y: 20, w: 420, h: 300, color, text: `---\nlabel: ${id}\n---\n## ${id}`,
});

function publishedBounds() {
  const document = buildOpenApiDocument() as unknown as {
    components: {
      schemas: {
        RecipeLayoutInput: {
          properties: Record<
            "steps" | "sources",
            { maxProperties: number; propertyNames: { maxLength: number } }
          >;
        };
      };
    };
  };
  const { steps, sources } =
    document.components.schemas.RecipeLayoutInput.properties;
  return {
    stepsMax: steps.maxProperties,
    sourcesMax: sources.maxProperties,
    stepKeyMax: steps.propertyNames.maxLength,
    sourceKeyMax: sources.propertyNames.maxLength,
  };
}

const positionMap = (count: number, prefix: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}${index}`,
      { x: index, y: index },
    ]),
  );

const positionMapAtBoundary = (
  count: number,
  keyLength: number,
  prefix: string,
) => ({
  ...positionMap(count - 1, prefix),
  ["k".repeat(keyLength)]: { x: count, y: -count },
});

describe("the layout document", () => {
  it("reads the empty document for a recipe never arranged, and not-found for one that does not exist", async () => {
    const id = await newRecipe();
    expect(await layout(id)).toEqual(EMPTY);
    expect((await readLayout(testAccountRequest(req("GET")), P("nope"))).status).toBe(404);
    expect((await write("nope", {})).status).toBe(404);
  });

  it("round-trips a document whole, stamps the write, and leaves the recipe read alone", async () => {
    const id = await newRecipe();
    const s1 = await newStep(id, "SELECT name FROM stations", "lay_one");
    const s2 = await newStep(id, "SELECT * FROM lay_one", "lay_two");
    const before = await recipe(id);
    const doc = {
      steps: { [s1]: { x: 360, y: 40 }, [s2]: { x: 680, y: 40.5 } },
      sources: { stations: { x: 40, y: 60 }, loose_table: { x: 40, y: 330 } },
      notes: [note("intake"), note("outputs", "blue")],
    };
    const written = await write(id, doc);
    expect(written.status).toBe(200);
    const answer = (await body(written)).layout as Json;
    expect(typeof answer.updatedAt).toBe("string");
    expect(answer).toEqual({ ...doc, updatedAt: answer.updatedAt });
    expect(await layout(id)).toEqual(answer);
    // The recipe itself: same steps, same everything, but the edit time.
    const after = await recipe(id);
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    expect(after).not.toHaveProperty("layout");
  });

  it("drops a position for a node the recipe does not have and stores the rest", async () => {
    const id = await newRecipe();
    const s1 = await newStep(id, "SELECT 1 AS n", "drop_one");
    const written = await write(id, {
      steps: { [s1]: { x: 1, y: 2 }, "not-a-node": { x: 3, y: 4 } },
      sources: { stations: { x: 5, y: 6 } },
    });
    expect(written.status).toBe(200);
    const answer = (await body(written)).layout as Json;
    expect(answer.steps).toEqual({ [s1]: { x: 1, y: 2 } });
    expect((await layout(id)).steps).toEqual({ [s1]: { x: 1, y: 2 } });
  });

  it("refuses a faulty document whole, names the fault, and stores nothing", async () => {
    const id = await newRecipe();
    const s1 = await newStep(id, "SELECT 1 AS n", "ref_one");
    const good = { steps: { [s1]: { x: 1, y: 2 } }, notes: [note("a")] };
    expect((await write(id, good)).status).toBe(200);
    const stored = await layout(id);
    const refused = async (doc: unknown, pattern: RegExp) => {
      const response = await write(id, doc);
      expect(response.status).toBe(400);
      const error = (await body(response)).error as Json;
      expect(error.code).toBe("invalid_request");
      expect(error.message).toMatch(pattern);
      expect(await layout(id)).toEqual(stored);
    };
    await refused([], /JSON object/);
    await refused({ steps: { [s1]: { x: "1", y: 2 } } }, /steps\..*\.x must be a finite number/);
    await refused({ notes: [note("a", "teal")] }, /color must be one of/);
    await refused({ notes: [{ ...note("a"), text: "x".repeat(4001) }] }, /4001 characters/);
    await refused({ notes: [{ ...note("a"), w: 0 }] }, /w must be positive/);
    await refused({ notes: [{ ...note("a"), h: -1 }] }, /h must be positive/);
    await refused({ notes: [note(" ")] }, /id must be a non-blank string/);
    await refused({ notes: [note("a"), note("a")] }, /duplicates/);
    await refused({ notes: Array.from({ length: 101 }, (_, i) => note(`n${i}`)) }, /at most 100/);
    // Not JSON at all.
    const broken = await putLayout(testAccountRequest(req("PUT", undefined, "{not json")), P(id));
    expect(broken.status).toBe(400);
    expect(await layout(id)).toEqual(stored);
  });

  describe("bounded position maps", () => {
    const bounds = publishedBounds();
    const excesses = [
      {
        case: "steps count",
        document: { steps: positionMap(bounds.stepsMax + 1, "unknown-step-") },
        message: `steps holds ${bounds.stepsMax + 1}; a document holds at most ${bounds.stepsMax}.`,
      },
      {
        case: "sources count",
        document: { sources: positionMap(bounds.sourcesMax + 1, "source-") },
        message: `sources holds ${bounds.sourcesMax + 1}; a document holds at most ${bounds.sourcesMax}.`,
      },
      {
        case: "step key length",
        document: {
          steps: { ["k".repeat(bounds.stepKeyMax + 1)]: { x: 1, y: 2 } },
        },
        message: `steps has a key of ${bounds.stepKeyMax + 1} characters; a key holds at most ${bounds.stepKeyMax}.`,
      },
      {
        case: "source key length",
        document: {
          sources: { ["k".repeat(bounds.sourceKeyMax + 1)]: { x: 1, y: 2 } },
        },
        message: `sources has a key of ${bounds.sourceKeyMax + 1} characters; a key holds at most ${bounds.sourceKeyMax}.`,
      },
    ];

    it.each(excesses)(
      "refuses $case whole and preserves the stored document",
      async ({ document, message }) => {
        const id = await newRecipe();
        const stepId = await newStep(id, "SELECT 1 AS n", "bounded_one");
        const valid = { steps: { [stepId]: { x: 1, y: 2 } }, notes: [note("safe")] };
        expect((await write(id, valid)).status).toBe(200);
        const stored = await layout(id);

        const response = await write(id, document);
        expect(response.status).toBe(400);
        const error = (await body(response)).error as Json;
        expect(error).toEqual({ code: "invalid_request", message });
        expect(await layout(id)).toEqual(stored);
      },
    );

    it("round-trips the full source boundary with a maximum key and a real step identity", async () => {
      const id = await newRecipe();
      const stepId = await newStep(id, "SELECT 1 AS n", "boundary_one");
      const document = {
        steps: { [stepId]: { x: 11, y: 12 } },
        sources: positionMapAtBoundary(
          bounds.sourcesMax,
          bounds.sourceKeyMax,
          "source-",
        ),
        notes: [note("boundary")],
      };

      const response = await write(id, document);
      expect(response.status).toBe(200);
      const answer = (await body(response)).layout as Json;
      expect(answer).toEqual({ ...document, updatedAt: answer.updatedAt });
      expect(await layout(id)).toEqual(answer);
      expect((answer.steps as Json)[stepId]).toEqual({ x: 11, y: 12 });
      expect(Object.keys(answer.sources as Json)).toHaveLength(bounds.sourcesMax);
      expect(answer.sources as Json).toHaveProperty("k".repeat(bounds.sourceKeyMax));
    });
  });

  it("a changed write is an edit, an identical one is not, and a run is not", async () => {
    const id = await newRecipe();
    const s1 = await newStep(id, "SELECT 1 AS n", "edit_one");
    const at = async () => (await recipe(id)).updatedAt as string;
    const t0 = await at();
    expect((await write(id, { steps: { [s1]: { x: 10, y: 10 } }, notes: [note("a")] })).status).toBe(200);
    const t1 = await at();
    expect(t1 > t0).toBe(true);
    // The same document, keys in another order: nothing changed, nothing moves.
    expect((await write(id, { notes: [{ text: note("a").text, color: "yellow", h: 300, w: 420, y: 20, x: 20, id: "a" }], steps: { [s1]: { y: 10, x: 10 } } })).status).toBe(200);
    expect(await at()).toBe(t1);
    // A refused write moves nothing either.
    expect((await write(id, { notes: [note("a", "teal")] })).status).toBe(400);
    expect(await at()).toBe(t1);
    // A run is not an edit.
    const run = await runStep(testAccountRequest(req("POST", {})), { params: Promise.resolve({ id, stepId: s1 }) });
    expect(run.status).toBe(202);
    await laneSettled();
    expect(await at()).toBe(t1);
    // Moving the node again is.
    expect((await write(id, { steps: { [s1]: { x: 11, y: 10 } }, notes: [note("a")] })).status).toBe(200);
    expect((await at()) > t1).toBe(true);
  });

  it("sending back exactly what a read returned is never an edit: the never-written and the just-pruned cases", async () => {
    // Never arranged: the empty document is what is there, so writing it
    // back stores nothing and moves nothing — the write time stays null.
    const id = await newRecipe();
    const s1 = await newStep(id, "SELECT 1 AS n", "noop_one");
    const s2 = await newStep(id, "SELECT 2 AS n", "noop_two");
    const at = async () => (await recipe(id)).updatedAt as string;
    const t0 = await at();
    const first = await layout(id);
    const echoed = await write(id, { steps: first.steps, sources: first.sources, notes: first.notes });
    expect(echoed.status).toBe(200);
    expect(((await body(echoed)).layout as Json).updatedAt).toBeNull();
    expect((await write(id, {})).status).toBe(200);
    expect(await at()).toBe(t0);
    expect(await layout(id)).toEqual(EMPTY);
    // Arranged, then a node removed: the row still carries the lost node,
    // a read prunes it, and writing the read back is not a change.
    expect((await write(id, { steps: { [s1]: { x: 1, y: 1 }, [s2]: { x: 2, y: 2 } }, notes: [note("a")] })).status).toBe(200);
    const t1 = await at();
    expect(t1 > t0).toBe(true);
    const removed = await removeStep(testAccountRequest(req("DELETE")), { params: Promise.resolve({ id, stepId: s2 }) });
    expect(removed.status).toBe(200);
    const t2 = await at();
    const read = await layout(id);
    expect(read.steps).toEqual({ [s1]: { x: 1, y: 1 } });
    const same = await write(id, { steps: read.steps, sources: read.sources, notes: read.notes });
    expect(same.status).toBe(200);
    expect(((await body(same)).layout as Json).updatedAt).toBe(read.updatedAt);
    expect(await at()).toBe(t2);
  });

  it("after a node is removed a read no longer names it; after the recipe goes, nothing is left", async () => {
    const id = await newRecipe();
    const s1 = await newStep(id, "SELECT 1 AS n", "gone_one");
    const s2 = await newStep(id, "SELECT 2 AS n", "gone_two");
    await write(id, {
      steps: { [s1]: { x: 1, y: 1 }, [s2]: { x: 2, y: 2 } },
      sources: { stations: { x: 3, y: 3 } },
      notes: [note("keep")],
    });
    const removed = await removeStep(testAccountRequest(req("DELETE")), { params: Promise.resolve({ id, stepId: s2 }) });
    expect(removed.status).toBe(200);
    const after = await layout(id);
    expect(after.steps).toEqual({ [s1]: { x: 1, y: 1 } });
    expect(after.sources).toEqual({ stations: { x: 3, y: 3 } });
    expect(after.notes).toEqual([note("keep")]);
    // Deleting the recipe takes the document with it.
    expect((await deleteRecipeRoute(testAccountRequest(req("DELETE")), P(id))).status).toBe(200);
    expect(metadataDb().prepare(`SELECT count(*) AS n FROM recipe_layouts`).get()).toEqual({ n: 0 });
    expect((await readLayout(testAccountRequest(req("GET")), P(id))).status).toBe(404);
  });

  it("goes with a duplicate, under the copy's node identities; the original's stays", async () => {
    const id = await newRecipe("Arranged");
    const s1 = await newStep(id, "SELECT name FROM stations", "dup_one");
    const s2 = await newStep(id, "SELECT * FROM dup_one", "dup_two");
    const doc = {
      steps: { [s1]: { x: 360, y: 40 }, [s2]: { x: 680, y: 40 } },
      sources: { stations: { x: 40, y: 60 }, loose_table: { x: 40, y: 330 } },
      notes: [note("intake"), note("outputs", "pink")],
    };
    expect((await write(id, doc)).status).toBe(200);
    const original = await layout(id);
    const dup = await duplicateRecipeRoute(testAccountRequest(req("POST")), P(id));
    expect(dup.status).toBe(201);
    const copy = (await body(dup)).recipe as Json;
    const [c1, c2] = (copy.steps as Json[]).map((s) => s.id as string);
    expect(new Set([c1, c2]).has(s1)).toBe(false);
    const copied = await layout(copy.id as string);
    expect(copied.steps).toEqual({ [c1]: { x: 360, y: 40 }, [c2]: { x: 680, y: 40 } });
    expect(copied.sources).toEqual(doc.sources);
    expect(copied.notes).toEqual(doc.notes);
    expect(typeof copied.updatedAt).toBe("string");
    expect(await layout(id)).toEqual(original);
    // A copy of a recipe never arranged reads the empty document.
    const bare = await newRecipe("Bare");
    await newStep(bare, "SELECT 1 AS n", "bare_one");
    const bareCopy = (await body(await duplicateRecipeRoute(testAccountRequest(req("POST")), P(bare)))).recipe as Json;
    expect(await layout(bareCopy.id as string)).toEqual(EMPTY);
  });
});
