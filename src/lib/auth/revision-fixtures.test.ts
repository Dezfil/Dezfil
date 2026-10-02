import { afterEach, expect, it, vi } from "vitest";
import { captureBasis, fixtureHeaders, declaredToolArguments } from "../../../scripts/revision-fixtures.mjs";
import { journeyApi } from "../../../scripts/journey-http.mjs";
import { journeyClient } from "../../../scripts/mcp-journey-core.mjs";
import { authenticatedRequest } from "../assistant/testing/account";
import { buildTools } from "../tools/tools";
import { toolRequest } from "../tools/request";

afterEach(() => vi.restoreAllMocks());

it("sends the explicitly captured basis once and leaves missing/malformed negative probes intact", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: "stale_revision" } }, { status: 409 }));
  const api = journeyApi("http://fixture.test");
  const shown = { editRevision: "before" };
  const basis = captureBasis(shown);
  shown.editRevision = "after";
  await api("PATCH", "/api/maps/m", { body: { name: "Old intent" }, basis });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("X-Edit-Revision")).toBe("before");
  expect(new Headers(fixtureHeaders(undefined)).has("X-Edit-Revision")).toBe(false);
  expect(new Headers(fixtureHeaders({ editRevision: "malformed" })).get("X-Edit-Revision")).toBe("malformed");
  expect(() => captureBasis({ name: "No read" })).toThrow(/revision/i);
});

it("adds only a declared tool property and preserves explicit external arguments", () => {
  const declared = { inputSchema: { properties: { expected_revision: { type: "string" } } } };
  expect(declaredToolArguments({ inputSchema: { properties: {} } }, { id: "m" }, { editRevision: "held" })).toEqual({ id: "m" });
  expect(declaredToolArguments(declared, { id: "m" }, { editRevision: "held" })).toEqual({ id: "m", expected_revision: "held" });
  expect(declaredToolArguments(declared, { id: "m", expected_revision: "explicit-stale" }, { editRevision: "held" })).toEqual({ id: "m", expected_revision: "explicit-stale" });
});

it("keeps assistant fixture credentials apart from explicit per-call revisions", () => {
  const request = new Request("http://fixture.test/api/maps/m", { method: "PATCH", headers: { authorization: "Bearer fixture" }, body: '{}' });
  const input = authenticatedRequest(request, { editRevision: "captured" });
  expect(input.headers.get("authorization")).toBe("Bearer fixture");
  expect(input.headers.get("X-Edit-Revision")).toBe("captured");
});

it("routes an external revision argument to the declared HTTP header without putting it in the payload", () => {
  const existing = buildTools().find(tool => tool.name === "update_map")!;
  const declared = { ...existing, headerParams: [...(existing.headerParams ?? []), { name: "X-Edit-Revision", argument: "expected_revision" }] };
  const { init } = toolRequest(declared, { id: "m", name: "New name", expected_revision: "external-stale" }, "http://fixture.test");
  expect(new Headers(init.headers).get("X-Edit-Revision")).toBe("external-stale");
  expect(JSON.parse(String(init.body))).toEqual({ name: "New name" });
});

it("carries a held basis through the stock MCP fixture while confirmation reads never replace it", async () => {
  const client = {
    listTools: async () => ({ tools: [{ name: "delete_map", inputSchema: { properties: { expected_revision: {} } }, _meta: {
      "dezfil/confirmation": { policy: "required", target: "Delete {target}", consequence: "Delete", subject: { path: "/api/maps/{id}", name: "name" } },
      "dezfil/effects": {},
    } }] }),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }], structuredContent: { result: {}, history: null } })),
  };
  const read = vi.fn(async () => ({ name: "Map", editRevision: "newer" }));
  const journey = await journeyClient(client, read);
  await journey.gate("delete_map", { id: "m" }, true, { editRevision: "shown" });
  expect(client.callTool).toHaveBeenCalledWith({ name: "delete_map", arguments: { id: "m", expected_revision: "shown" } });
  expect(read).toHaveBeenCalledTimes(1);
});
