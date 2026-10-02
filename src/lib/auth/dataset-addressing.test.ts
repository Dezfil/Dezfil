import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { testClient } from "@/lib/mcp/test-client";
import { runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import type { DataTable } from "@/lib/metadata/tables";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { PERMISSION_REFUSAL } from "./reach";
import type { AccountScope } from "./scope";

/**
 * Addressing a dataset in a standalone request. Ada files `roads` in her
 * project, where Bob is a viewer, and keeps `parks` to herself; Bob owns a
 * `roads` of his own with two rows; Cyd belongs to nothing.
 *
 * A bare name is the caller's own dataset, as it always was; another
 * person's dataset is addressed by its qualified name or its identifier, on
 * REST, MCP and the assistant alike; one out of reach is absent, byte-equal
 * to one that does not exist; and a change to another person's dataset is
 * refused by the permission shape whatever names it.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "dataset-addressing-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name, rows] of [["ada", "roads", 1], ["ada", "parks", 1], ["bob", "roads", 2]] as const) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${Array.from({ length: rows }, (_, i) => `${owner} ${name},${i + 1},2`).join("\n")}\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "viewer"]], [tables["ada.roads"].id]);
});
afterEach(async () => { vi.unstubAllGlobals(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const handlers = {
  table: () => import("@/app/api/tables/[name]/route"),
  features: () => import("@/app/api/tables/[name]/features/route"),
  export: () => import("@/app/api/tables/[name]/export/route"),
  refresh: () => import("@/app/api/tables/[name]/refresh/route"),
  geometry: () => import("@/app/api/tables/[name]/geometry/route"),
  preview: () => import("@/app/api/tables/[name]/geometry/preview/route"),
  operation: () => import("@/app/api/operations/run/route"),
};
/** The instance, as one account calls it: every request is that account's. */
function instance(account: string, kind: "session" | "token" = "session") {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(raw.headers);
    headers.delete("authorization"); headers.delete("cookie");
    const request = testAccountRequest(new Request(raw, { headers }), undefined, account);
    if (kind === "token") {
      const token = createApiToken(requireRequestAuth(request), "Addressing", undefined);
      request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
    }
    const url = new URL(request.url);
    const parts = url.pathname.split("/").map(decodeURIComponent);
    const name = parts[3];
    const load: () => Promise<Record<string, unknown>> = url.pathname === "/api/operations/run" ? handlers.operation
      : parts.length === 4 ? handlers.table : parts[4] === "geometry" && parts[5] === "preview" ? handlers.preview : handlers[parts[4] as "features" | "export" | "refresh" | "geometry"];
    return ((await load())[request.method] as Handler)(request, { params: Promise.resolve({ name }) });
  };
}
async function rest(account: string, url: string, method = "GET", body?: unknown, kind: "session" | "token" = "session") {
  const response = await instance(account, kind)(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as unknown : null };
}
const at = (name: string) => `/api/tables/${encodeURIComponent(name)}`;

describe("addressing a dataset on REST", () => {
  it("keeps a bare name the caller's own and reaches another person's by qualified name or identifier", async () => {
    expect((await rest("bob", at("roads"))).body).toMatchObject({ id: tables["bob.roads"].id, qualifiedName: "roads", rowCount: 2 });
    expect((await rest("bob", at("bob.roads"))).body).toMatchObject({ id: tables["bob.roads"].id });
    for (const address of ["ada.roads", tables["ada.roads"].id]) {
      const read = await rest("bob", at(address));
      expect(read.status, address).toBe(200);
      expect(read.body, address).toMatchObject({ id: tables["ada.roads"].id, qualifiedName: "ada.roads", owner: { sqlName: "ada" }, preview: [{ sentinel: "ada roads" }] });
      const features = await rest("bob", `${at(address)}/features`);
      expect(features.body, address).toMatchObject({ ok: true, featureCount: 1 });
      const exported = await rest("bob", `${at(address)}/export?format=csv`);
      expect(exported.status, address).toBe(200);
      expect(exported.text).toContain("ada roads");
      expect(exported.text).not.toContain("bob roads");
    }
    expect((await rest("ada", at("roads"))).body).toMatchObject({ id: tables["ada.roads"].id, qualifiedName: "roads" });
  });

  it("refuses a dataset out of reach exactly as one that does not exist, on session and token", async () => {
    for (const suffix of ["", "/features", "/export?format=csv"]) {
      for (const kind of ["session", "token"] as const) {
        const missing = await rest("bob", `${at("ada.never_existed")}${suffix}`, "GET", undefined, kind);
        expect(missing.status).toBe(404);
        for (const [account, address] of [["bob", "ada.parks"], ["bob", tables["ada.parks"].id], ["bob", "parks"], ["cyd", "ada.roads"], ["cyd", tables["ada.roads"].id]]) {
          const hidden = await rest(account, `${at(address)}${suffix}`, "GET", undefined, kind);
          expect(hidden.status, `${account} ${address}${suffix}`).toBe(404);
          expect(hidden.body, `${account} ${address}${suffix}`).toEqual(missing.body);
        }
      }
    }
  });

  it("refuses a change to another person's dataset by the permission shape, whatever names it, and changes nothing", async () => {
    const row = () => metadataDb().prepare("SELECT * FROM data_tables WHERE id = ?").get(tables["ada.roads"].id);
    const before = { row: row(), bytes: await readFile(path.join(directory, tables["ada.roads"].file)) };
    const choice = { expectedRevision: "r", choice: { format: "pair", columns: ["lon", "lat"] } };
    for (const address of ["ada.roads", tables["ada.roads"].id]) {
      for (const [suffix, method, body] of [["", "DELETE"], ["/refresh", "POST", {}], ["/geometry", "GET"], ["/geometry", "PUT", choice],
        ["/geometry?expectedRevision=r", "DELETE"], ["/geometry/preview", "POST", choice]] as [string, string, unknown?][]) {
        const refused = await rest("bob", `${at(address)}${suffix}`, method, body);
        expect(refused, `${method} ${address}${suffix}`).toMatchObject({ status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } });
      }
    }
    const hidden = await rest("bob", at("ada.parks"), "DELETE"), missing = await rest("bob", at("ada.never_existed"), "DELETE");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(row()).toEqual(before.row);
    expect(await readFile(path.join(directory, tables["ada.roads"].file))).toEqual(before.bytes);
  });

  it("names datasets in standalone operations by the same rule", async () => {
    const dry = (input: string) => rest("bob", "/api/operations/run", "POST", { operation: "buffer", dryRun: true, parameters: { input, distance: 10, name: "rings" } });
    const own = await dry("roads"), theirs = await dry("ada.roads");
    expect(own.status).toBe(200);
    expect(theirs.status).toBe(200);
    expect(own.body).toMatchObject({ dryRun: { rowCount: 2 } });
    expect(theirs.body).toMatchObject({ dryRun: { rowCount: 1 } });
    const hidden = await dry("ada.parks"), missing = await dry("ada.never_existed");
    expect(hidden.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(hidden.body)).toBe(JSON.stringify(missing.body).replace("ada.never_existed", "ada.parks"));
    expect(JSON.stringify(hidden.body)).not.toMatch(/exist|ada roads|project/i);
  });
});

describe("addressing a dataset through MCP and the assistant", () => {
  it("serves another person's dataset by its qualified name to an MCP caller, and refuses one out of reach as a missing one", async () => {
    const client = await testClient(instance("bob"));
    try {
      const read = await client.callTool({ name: "inspect_table", arguments: { name: "ada.roads" } }) as { isError?: boolean; structuredContent: { result: Record<string, unknown> } };
      expect(read.isError).toBeFalsy();
      expect(read.structuredContent.result).toMatchObject({ id: tables["ada.roads"].id, qualifiedName: "ada.roads" });
      const own = await client.callTool({ name: "inspect_table", arguments: { name: "roads" } }) as { structuredContent: { result: Record<string, unknown> } };
      expect(own.structuredContent.result).toMatchObject({ id: tables["bob.roads"].id });
      const hidden = await client.callTool({ name: "inspect_table", arguments: { name: "ada.parks" } });
      const missing = await client.callTool({ name: "inspect_table", arguments: { name: "ada.never_existed" } });
      expect((hidden as { isError?: boolean }).isError).toBe(true);
      expect(hidden).toEqual(missing);
    } finally { await client.close(); }
  });

  it("serves the same to the assistant's tool calls", async () => {
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "theirs", name: "inspect_table", args: { name: "ada.roads" } }] },
      { text: "", toolCalls: [{ id: "hidden", name: "inspect_table", args: { name: "ada.parks" } }] },
      { text: "", toolCalls: [{ id: "missing", name: "inspect_table", args: { name: "ada.never_existed" } }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Read the roads", history: [] },
      { scope: scopes.bob, baseUrl: "http://instance.test", fetchImpl: instance("bob"), pending: new PendingActionStore(), discovery: false })) events.push(event);
    const result = (id: string) => events.find((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result" && event.id === id)!;
    expect(result("theirs")).toMatchObject({ ok: true, body: { id: tables["ada.roads"].id, qualifiedName: "ada.roads" } });
    expect(result("hidden")).toMatchObject({ ok: false, body: { error: { code: "not_found" } } });
    expect(result("hidden").body).toEqual(result("missing").body);
  });
});
