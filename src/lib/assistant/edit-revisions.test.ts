import { expect, it } from "vitest";
import { AssistantRevisions, withoutWriteRevision } from "./edit-revisions";
import { buildTools } from "@/lib/tools/tools";

it("chains accepted revisions by document without a turn stamp or a hidden read", () => {
  const ledger = new AssistantRevisions();
  const tool = { ...buildTools().find((t) => t.name === "update_layer")!, headerParams: [{ name: "X-Edit-Revision", argument: "expected_revision" }] };
  ledger.observe("/api/maps/a", { id: "a", editRevision: "first", layers: [{ id: "layer", mapId: "a" }] });
  ledger.observe("/api/maps/b", { id: "b", editRevision: "other" });
  const args = Object.fromEntries(tool.pathParams.map((key) => [key, "layer"]));
  expect(ledger.headers(tool, args)).toEqual({ "X-Edit-Revision": "first" });
  ledger.observe("/api/layers/layer", { id: "layer", mapId: "a", editRevision: "second" });
  expect(ledger.headers(tool, args)).toEqual({ "X-Edit-Revision": "second" });
  expect(ledger.revision("map:b")).toBe("other");
  expect(ledger.headers({ ...tool, headerParams: [] }, args)).toEqual({});
  expect(withoutWriteRevision({ "x-edit-revision": "old", "X-Change-Group": "group" })).toEqual({ "X-Change-Group": "group" });
  // A resumed execution owns a new ledger, populated by its fresh grounding.
  expect(new AssistantRevisions().headers(tool, args)).toEqual({});
});

it("the real loop uses each accepted result and parks no write revision across resume", async () => {
  const { testAccountScope } = await import("@/lib/test-support/accounts");
  const { runAssistant, resumeAssistant } = await import("./loop");
  const { stubProvider } = await import("./providers/stub");
  const { PendingActionStore } = await import("./pending");
  const ledger = new AssistantRevisions();
  ledger.observe("/api/maps/map", { id: "map", editRevision: "initial", layers: [{ id: "layer", mapId: "map" }] });
  const base = buildTools().find((t) => t.name === "update_layer")!;
  const tool = { ...base, confirm: false, headerParams: [{ name: "X-Edit-Revision", argument: "expected_revision" }] };
  const gated = { ...tool, name: "confirmed_layer_change", confirm: true, confirmation: {
    target: "Change {target}?", consequence: "Changes the layer.", subject: { path: null, argument: tool.pathParams[0], name: "name" },
  } };
  const args = { [tool.pathParams[0]]: "layer", name: "changed", expected_revision: "model-stamp" };
  const provider = stubProvider([{ text: "", toolCalls: [
    { id: "one", name: tool.name, args }, { id: "two", name: tool.name, args }, { id: "three", name: gated.name, args },
  ] }, { text: "Done", toolCalls: [] }]);
  const sent: (string | null)[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "GET") return Response.json({ id: "layer", mapId: "map", editRevision: "after-wait" });
    sent.push(new Headers(init?.headers).get("X-Edit-Revision"));
    return Response.json({ id: "layer", mapId: "map", editRevision: `accepted-${sent.length}` });
  };
  const scope = testAccountScope(undefined, "revision-loop");
  const store = new PendingActionStore();
  const deps = { scope, pending: store, tools: [tool, gated], fetchImpl, baseUrl: "http://instance.test", autoCheck: false };
  let pending = "";
  for await (const event of runAssistant(provider, { message: "change", history: [] }, { ...deps, revisions: ledger })) {
    if (event.type === "confirm_required") pending = event.id;
  }
  expect(sent).toEqual(["initial", "accepted-1"]);
  const parked = store.claim(scope, pending, "approved")!;
  expect(Object.keys(parked.headers).map((k) => k.toLowerCase())).not.toContain("x-edit-revision");
  expect(parked.calls.every((call) => !("expected_revision" in call.args))).toBe(true);
  for await (const event of resumeAssistant(parked, true, deps)) void event;
  expect(sent).toEqual(["initial", "accepted-1", "after-wait"]);
});

it("owns every compound filing basis and parks none through a confirmation", async () => {
  const { assistantCall, assistantTools } = await import("./tool-surface");
  const tool = buildTools().find(t => t.name === "update_project_members")!;
  const create = buildTools().find(t => t.name === "create_project")!;
  const ledger = new AssistantRevisions();
  ledger.observe("/api/maps/m", { id: "m", editRevision: "map-first" });
  ledger.observe("/api/recipes/w", { recipe: { id: "w", editRevision: "workflow-first" } });
  const supplied = { addMaps: ["m"], addRecipes: ["w"], expectedRevisions: { "map:m": "model-stamp" } };
  const call = assistantCall({ id: "call", name: tool.name, args: supplied }, tool);
  expect(call.args).not.toHaveProperty("expectedRevisions");
  expect(assistantTools([tool])[0].inputSchema.properties).not.toHaveProperty("expectedRevisions");
  expect(ledger.bodyArguments(tool, call.args)).toMatchObject({ expectedRevisions: { "map:m": "map-first", "workflow:w": "workflow-first" } });
  ledger.observe("/api/projects/p/members", { revisions: [{ kind: "map", id: "m", editRevision: "map-accepted" }, { kind: "workflow", id: "w", editRevision: "workflow-accepted" }] });
  expect(ledger.bodyArguments(create, { name: "New", members: supplied })).toMatchObject({ members: { expectedRevisions: { "map:m": "map-accepted", "workflow:w": "workflow-accepted" } } });
  const resumed = new AssistantRevisions(), paths: string[] = [];
  await resumed.readOnResume(tool, call.args, "http://instance.test", async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    return Response.json(path.includes("maps") ? { id: "m", editRevision: "after-wait-m" } : { recipe: { id: "w", editRevision: "after-wait-w" } });
  });
  expect(paths).toEqual(["/api/maps/m", "/api/recipes/w"]);
  expect(resumed.bodyArguments(tool, call.args)).toMatchObject({ expectedRevisions: { "map:m": "after-wait-m", "workflow:w": "after-wait-w" } });
});

it("the loop starts a leaf from its planning result and does not replace it with a later read", async () => {
  const { testAccountScope } = await import("@/lib/test-support/accounts");
  const { runAssistant } = await import("./loop");
  const { stubProvider } = await import("./providers/stub");
  const tool = buildTools().find(t => t.name === "run_recipe")!;
  const sent: (string | null)[] = [], reads: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    reads.push(String(input));
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.plan) return Response.json({ editRevision: "planned", plan: { wide: false, members: ["s"] } });
    sent.push(new Headers(init?.headers).get("X-Edit-Revision"));
    return Response.json({ error: { code: "stale_revision", message: "This item has changed. Reload it before trying again." } }, { status: 409 });
  };
  const provider = stubProvider([{ text: "", toolCalls: [{ id: "run", name: tool.name, args: { id: "w", fromStepId: "s", expected_revision: "invented" } }] }, { text: "Done", toolCalls: [] }]);
  for await (const event of runAssistant(provider, { message: "Run", history: [] }, { scope: testAccountScope(undefined, "start-basis"), tools: [tool], fetchImpl, baseUrl: "http://instance.test", autoCheck: false })) void event;
  expect(sent).toEqual(["planned"]); expect(reads).toEqual(["http://instance.test/api/recipes/w/runs", "http://instance.test/api/recipes/w/runs"]);
});

it("a resumed confirmation uses intervening saves even without an earlier write in its turn", async () => {
  const { testAccountScope } = await import("@/lib/test-support/accounts");
  const { runAssistant, resumeAssistant } = await import("./loop");
  const { stubProvider } = await import("./providers/stub");
  const { PendingActionStore } = await import("./pending");
  const ledger = new AssistantRevisions();
  ledger.observe("/api/maps/m", { id: "m", editRevision: "before-wait", layers: [{ id: "l", mapId: "m" }] });
  const tool = { ...buildTools().find(t => t.name === "update_layer")!, confirm: true,
    confirmation: { target: "Change {target}?", consequence: "Changes the layer.", subject: { path: null, argument: "id", name: "name" } } };
  const sent: (string | null)[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "GET") return Response.json({ id: "l", mapId: "m", editRevision: "intervening-save" });
    sent.push(new Headers(init?.headers).get("X-Edit-Revision"));
    return Response.json({ id: "l", mapId: "m", editRevision: "accepted" });
  };
  const scope = testAccountScope(undefined, "resume-basis"), pending = new PendingActionStore();
  const deps = { scope, pending, tools: [tool], fetchImpl, baseUrl: "http://fixture.test", autoCheck: false };
  const provider = stubProvider([{ text: "", toolCalls: [{ id: "c", name: tool.name, args: { [tool.pathParams[0]]: "l", name: "New" } }] }, { text: "Done", toolCalls: [] }]);
  let id = "";
  for await (const event of runAssistant(provider, { message: "Change", history: [] }, { ...deps, revisions: ledger })) if (event.type === "confirm_required") id = event.id;
  expect(sent).toEqual([]);
  const parked = pending.claim(scope, id, "approved")!;
  for await (const event of resumeAssistant(parked, true, deps)) void event;
  expect(sent).toEqual(["intervening-save"]);
});
