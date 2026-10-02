import { describe, expect, it } from "vitest";
import { loadGrounding, GROUNDING_MAX_BYTES } from "./grounding";
import type { AssistantContext } from "./context";

const table = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`, name, qualifiedName: name, owner: { name: "Ada", sqlName: "ada" }, rowCount: 3, geometryColumn: "geom", geometryType: "POINT", crsAssumed: false,
  columns: [{ name: "value", type: "INTEGER" }], columnCount: 1, nextColumnOffset: null, ...extra,
});
const layer = (id: string, extra: Record<string, unknown> = {}) => ({ id, mapId: "m", name: id, sql: "SELECT * FROM z_dependency", style: { fill: [1, 2, 3] }, visible: false, filters: [], ...extra });
const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, recipeId: "r", operation: "sql_step", parameters: { sql: "SELECT 1", name: id }, proposedParameters: { sql: "SELECT 2", name: id }, ...extra });
function api(options: { layers?: unknown[]; steps?: unknown[]; members?: unknown[]; tables?: ReturnType<typeof table>[]; fail?: string; project?: boolean } = {}) {
  const tables = options.tables ?? [table("a"), table("y_project"), table("z_dependency")];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === options.fail) return Response.json({ error: { code: "internal" } }, { status: 500 });
    if (url.pathname === "/api/maps/m") return Response.json({ id: "m", name: "Map", projectId: options.project ? "p" : null, layers: options.layers ?? [layer("l")], password: "SECRET" });
    if (url.pathname === "/api/maps/m/dependencies") return Response.json({ datasets: [table("z_dependency")] });
    if (url.pathname === "/api/recipes/r") return Response.json({ recipe: { id: "r", name: "Recipe", steps: options.steps ?? [step("s")], credential: "SECRET" } });
    if (url.pathname === "/api/recipes/r/runs/run") return Response.json({ run: { id: "run", recipeId: "r", outcome: "partly_completed", members: options.members ?? [] } });
    if (url.pathname === "/api/catalogue/tables") {
      const named = url.searchParams.get("names");
      const chosen = named ? tables.filter((entry) => entry.qualifiedName === named) : url.searchParams.has("project") ? tables.filter((entry) => entry.name === "y_project") : tables.slice(0, 32);
      return Response.json({ tables: chosen, total: tables.length, nextAfter: !named && tables.length > 32 ? chosen.at(-1)!.name : null });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
  return fetchImpl;
}
const builder: AssistantContext = { page: "builder", mapId: "m", selectedLayerId: "l" };
const workflow: AssistantContext = { page: "workflow", recipeId: "r", selectedStepId: "s", lastRunId: "run" };
async function ground(context: AssistantContext | undefined, fetchImpl: typeof fetch) { return JSON.parse(await loadGrounding(context, "http://localhost:3201", fetchImpl)); }

describe("bounded grounding projections", () => {
  it("grounds two owners' same-named datasets apart, each read by the name its reader would type", async () => {
    const tables = [table("roads", { id: "own" }), table("roads", { id: "theirs", qualifiedName: "ada.roads" })];
    const value = await ground(undefined, api({ tables }));
    expect(value.catalogue.items.map((item: { id: string; qualifiedName: string; read: string }) => [item.id, item.qualifiedName, item.read])).toEqual([
      ["own", "roads", "/api/catalogue/tables?names=roads"],
      ["theirs", "ada.roads", "/api/catalogue/tables?names=ada.roads"],
    ]);
  });

  it("names each table as the page's own SQL does when the page's home is someone else's", async () => {
    const tables = [
      table("roads", { id: "mine", owner: { name: "Bob", sqlName: "bob" }, projectIds: [] }),
      table("roads", { id: "hers", qualifiedName: "ada.roads", projectIds: ["p"] }),
      table("z_dependency"),
    ];
    const homed = (fetchImpl: typeof fetch, home: string, steps?: unknown[]): typeof fetch => async (input) => {
      const response = await fetchImpl(input);
      const url = new URL(String(input));
      if (url.pathname === "/api/maps/m") return Response.json({ ...await response.json(), home });
      if (url.pathname === "/api/recipes/r") {
        const body = await response.json() as { recipe: Record<string, unknown> };
        return Response.json({ recipe: { ...body.recipe, home, ...(steps ? { steps } : {}) } });
      }
      return response;
    };
    const names = (value: { catalogue: { items: { id: string; homeName?: string; projectIds?: string[] }[] } }) =>
      value.catalogue.items.filter((item) => item.id !== "id-z_dependency").map((item) => [item.id, item.homeName, item.projectIds]);
    const onAdasMap = await ground({ ...builder, selectedLayerId: null }, homed(api({ tables, layers: [] }), "ada"));
    expect(onAdasMap.map.home).toBe("ada");
    expect(names(onAdasMap)).toEqual([["mine", "bob.roads", []], ["hers", "roads", ["p"]]]);
    // Her workflow's own output takes the plain name: her roads is qualified.
    const inHerWorkflow = await ground({ ...workflow, selectedStepId: null, lastRunId: null },
      homed(api({ tables }), "ada", [step("roads", { parameters: { sql: "SELECT 1", name: "roads" }, proposedParameters: null })]));
    expect(inHerWorkflow.recipe.home).toBe("ada");
    expect(names(inHerWorkflow)).toEqual([["mine", "bob.roads", []], ["hers", "ada.roads", ["p"]]]);
    // With no page, nothing is named for a page.
    expect(names(await ground(undefined, api({ tables })))).toEqual([["mine", undefined, []], ["hers", undefined, ["p"]]]);
    // A SQL name or a dataset name that is also a keyword is quoted, as the
    // engine must read it back.
    const keywords = [
      table("roads", { id: "ordered", qualifiedName: "order.roads", owner: { name: "Ord", sqlName: "order" }, projectIds: [] }),
      table("group", { id: "grouped", qualifiedName: "group", projectIds: [] }),
      table("z_dependency"),
    ];
    expect(names(await ground({ ...builder, selectedLayerId: null }, homed(api({ tables: keywords, layers: [] }), "ada"))))
      .toEqual([["ordered", '"order".roads', []], ["grouped", '"group"', []]]);
  });

  it("orders dependency/project/other table tiers and selected layers first", async () => {
    const value = await ground(builder, api({ project: true, layers: [layer("a"), layer("l")] }));
    expect(value.catalogue.items.map((item: { name: string }) => item.name)).toEqual(["z_dependency", "y_project", "a"]);
    expect(value.map.layers.items.map((item: { id: string }) => item.id)).toEqual(["l", "a"]);
    expect(value.map.layers.items[0]).toMatchObject({ sql: "SELECT * FROM z_dependency", style: { fill: [1, 2, 3] }, visible: false, filters: [] });
    expect((await ground(undefined, api())).catalogue.items.map((item: { name: string }) => item.name)).toEqual(["a", "y_project", "z_dependency"]);
  });
  it("caps tables and layers separately with counts and documented further reads", async () => {
    const tables = Array.from({ length: 33 }, (_, i) => table(`a_${String(i).padStart(2, "0")}`));
    const noMap = await ground(undefined, api({ tables }));
    expect(noMap.catalogue).toMatchObject({ total: 33, incomplete: true, read: "/api/catalogue/tables" });
    expect(noMap.catalogue.items).toHaveLength(32);
    const value = await ground(builder, api({ layers: [layer("l"), ...Array.from({ length: 32 }, (_, i) => layer(String(i)))] }));
    expect(value.map.layers.items).toHaveLength(32);
    expect(value.map.layers).toMatchObject({ total: 33, incomplete: true, read: "/api/maps/m" });
    expect(value.map.layers.items[0].id).toBe("l");
  });
  it("keeps active and proposed steps separate and caps steps and members independently", async () => {
    const steps = [step("s"), ...Array.from({ length: 64 }, (_, i) => step(String(i)))];
    const members = steps.map((entry) => ({ stepId: entry.id, state: "failed", stoppedBy: "cancelled", stoppedReason: "Cancelled by the user.", attempt: { state: "cancelled", error: { code: "operation_interrupted", message: "Stopped" } } }));
    const value = await ground(workflow, api({ steps, members }));
    expect(value.recipe.steps.items).toHaveLength(64);
    expect(value.recipe.steps).toMatchObject({ total: 65, incomplete: true });
    expect(value.recipe.steps.items[0]).toMatchObject({ id: "s", parameters: { sql: "SELECT 1" }, proposedParameters: { sql: "SELECT 2" } });
    expect(value.run.members.items).toHaveLength(64);
    expect(value.run.members).toMatchObject({ total: 65, incomplete: true });
    expect(value.run.members.items[0]).toMatchObject({ stepId: "s", state: "failed", stoppedBy: "cancelled", stoppedReason: "Cancelled by the user.", attempt: { state: "cancelled", error: { code: "operation_interrupted" } } });
  });
  it("preserves every documented member and attempt outcome separately", async () => {
    const members = ["pending", "running", "succeeded", "failed", "not_run"].map((state, i) => ({ stepId: String(i), state, attempt: state === "not_run" ? null : { state: ["queued", "running", "succeeded", "failed"][i] } }));
    members.push({ stepId: "cancel", state: "failed", attempt: { state: "cancelled" } });
    const value = await ground(workflow, api({ members }));
    expect(value.run.outcome).toBe("partly_completed");
    expect(value.run.members.items.map((member: { state: string }) => member.state)).toEqual(["pending", "running", "succeeded", "failed", "not_run", "failed"]);
    expect(value.run.members.items.at(-1).attempt.state).toBe("cancelled");
    expect(value.run.members.items[4].attempt).toBeNull();
  });
  it("omits an oversized definition whole, keeping its identity and further read", async () => {
    const value = await ground(builder, api({ layers: [layer("l", { sql: "x".repeat(100_000) })] }));
    expect(value.map.layers.items[0]).toEqual({ id: "l", incomplete: true, read: "/api/layers/l" });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(GROUNDING_MAX_BYTES);
    expect(value.map.layers.incomplete).toBe(true);
  });
  it("holds the 96 KiB UTF-8 budget at its fit transition", async () => {
    const fetchFor = (length: number) => api({ layers: [layer("l", { sql: "é".repeat(length) })] });
    let low = 0, high = GROUNDING_MAX_BYTES;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      const value = await ground(builder, fetchFor(middle));
      if (value.map.layers.items[0].sql !== undefined) low = middle;
      else high = middle;
    }
    const fits = await ground(builder, fetchFor(low));
    const omitted = await ground(builder, fetchFor(high));
    expect(fits.map.layers.items[0].sql).toBe("é".repeat(low));
    expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThanOrEqual(GROUNDING_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(fits))).toBeGreaterThan(GROUNDING_MAX_BYTES - 2048);
    expect(omitted.map.layers.items[0]).toEqual({ id: "l", incomplete: true, read: "/api/layers/l" });
  });
  it("omits an API-oversized table definition while retaining its identity", async () => {
    const ordinary = api({ tables: [table("a")] });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.has("names") && !url.searchParams.has("columns")) {
        return Response.json({ error: { code: "catalogue_too_large" } }, { status: 422 });
      }
      return ordinary(input, init);
    };
    expect((await ground(undefined, fetchImpl)).catalogue).toMatchObject({ total: 1, incomplete: true, items: [{ id: "id-a", name: "a", incomplete: true, read: "/api/catalogue/tables?names=a" }] });
  });
  it("refuses identities that cannot fit instead of shortening them", async () => {
    const layers = [layer("l"), ...Array.from({ length: 31 }, (_, i) => layer(`${i}${"x".repeat(2000)}`))];
    await expect(ground(builder, api({ layers }))).rejects.toMatchObject({ code: "assistant_context_too_large" });
  });
  it("rejects missing and wrong-parent layer, step and run before catalogue work", async () => {
    for (const [context, fetchImpl] of [
      [{ ...builder, mapId: "missing" }, api()], [builder, api({ layers: [layer("l", { mapId: "other" })] })],
      [{ ...builder, selectedLayerId: "missing" }, api()], [workflow, api({ steps: [step("s", { recipeId: "other" })] })],
      [{ ...workflow, selectedStepId: "missing" }, api()], [{ ...workflow, lastRunId: "other" }, api()],
    ] as const) await expect(ground(context, fetchImpl)).rejects.toMatchObject({ code: "assistant_context_invalid" });
  });
  it("distinguishes failed reads from an empty instance", async () => {
    expect((await ground(undefined, api({ tables: [] }))).catalogue).toMatchObject({ total: 0, items: [], incomplete: false });
    await expect(ground(undefined, api({ fail: "/api/catalogue/tables" }))).rejects.toMatchObject({ code: "assistant_context_unavailable" });
  });
  it("excludes actual seeded rows, paths, credentials, connection config and attachment bytes", async () => {
    const privateFields = { password: "SECRET", connection: { host: "PRIVATE_HOST" }, file: "/PRIVATE_PATH", preview: [{ secret: "PRIVATE_ROW" }], content_base64: "PRIVATE_BYTES" };
    const value = await ground(builder, api({ layers: [layer("l", privateFields)], tables: [table("z_dependency", privateFields)] }));
    for (const secret of ["SECRET", "PRIVATE_HOST", "PRIVATE_PATH", "PRIVATE_ROW", "PRIVATE_BYTES"]) expect(JSON.stringify(value)).not.toContain(secret);
    const sql: AssistantContext = { page: "sql", draft: "SELECT 'SECRET';\n", selection: null, lastExecution: null };
    expect((await ground(sql, api({ tables: [] }))).context).toEqual(sql);
  });
});
