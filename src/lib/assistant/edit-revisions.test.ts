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
