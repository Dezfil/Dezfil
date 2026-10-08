import type { Database } from "better-sqlite3";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "@/lib/auth/http";
import { createApiToken } from "@/lib/auth/credentials";
import { readStoredSettings } from "@/lib/settings/store";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { mcpResult } from "@/lib/mcp/result";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";
import { GET } from "./route";

/**
 * The runtime configuration every signed-in account and agent reads
 * carries what new things start with: one flat `defaults` object keyed and
 * valued as the change operation takes them, every key present with its
 * effective value. The expected values are written out here.
 */
const origin = "http://instance.test";
/** With nothing stored: the product's own values. */
const PRODUCT = {
  "newMap.basemap": "auto", "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": "bottom-left",
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
};
/** Every default changed by an admin, none to its product value. */
const CHANGED = {
  "newMap.basemap": "streets", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75,
  "newMap.legendCorner": "top-right", "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10,
  "newLayer.lineOpacity": 100, "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
  "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "2560", "imageExport.shape": "1:1",
};

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  testAccountScope(db, "member");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.stubEnv("DEZFIL_SATELLITE_URL", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

function request(actor: string, path: string, method = "GET", body?: unknown) {
  return testAccountRequest(new Request(origin + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db, actor);
}
const memberToken = () => createApiToken(requireRequestAuth(request("member", "/api/account"), db), "Agent", db).secret;
/** The runtime read as a member, by session cookie or by bearer token. */
async function read(kind: "cookie" | "token") {
  const input = request("member", "/api/config");
  if (kind === "token") { input.headers.delete("cookie"); input.headers.set("authorization", `Bearer ${memberToken()}`); }
  const response = await GET(input);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.json();
}
/** An admin changes the defaults through the change operation. */
async function change(patch: Record<string, unknown>) {
  const response = await changeInstanceSettings(request("admin", "/api/instance/settings", "PATCH", patch));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}

describe("the runtime read's defaults", () => {
  it.each(["cookie", "token"] as const)("report every product default to a member by %s with nothing stored", async kind => {
    expect((await read(kind)).defaults).toEqual(PRODUCT);
  });

  it.each(["cookie", "token"] as const)("report what an admin changed to a member by %s", async kind => {
    await change(CHANGED);
    expect((await read(kind)).defaults).toEqual(CHANGED);
  });

  it("are keyed and valued as the change operation takes them: written back whole, they store exactly what was read", async () => {
    for (const reported of [PRODUCT, CHANGED]) {
      await change(reported);
      const { defaults } = await read("cookie");
      await change(defaults);
      expect(readStoredSettings(db)).toEqual(reported);
      expect((await read("token")).defaults).toEqual(reported);
    }
  });

  it("report Auto for a Satellite default while the instance offers no imagery", async () => {
    await change({ "newMap.basemap": "satellite" });
    expect((await read("cookie")).defaults["newMap.basemap"]).toBe("auto");
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://imagery.example/{z}/{x}/{y}.jpg");
    expect((await read("token")).defaults["newMap.basemap"]).toBe("satellite");
  });

  it.each(["cookie", "token"] as const)("carry the shortest password to a member by %s: 8 with nothing stored, then what an admin stored", async kind => {
    expect((await read(kind)).passwordMin).toBe(8);
    await change({ "security.passwordMin": 12 });
    expect((await read(kind)).passwordMin).toBe(12);
  });

  it("carry the shortest password to an agent through get_config, valid against the tool's documented output", async () => {
    await change({ "security.passwordMin": 12 });
    const tool = buildTools().find(candidate => candidate.name === "get_config")!;
    const result = await executeTool(tool, {}, origin,
      (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch,
      { authorization: `Bearer ${memberToken()}` });
    expect((result.body as { passwordMin: unknown }).passwordMin).toBe(12);
    const output = fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0]);
    const valid = async (body: unknown) => (await output["~standard"].validate(mcpResult(tool, { ...result, body }, null).structuredContent)).issues;
    expect(await valid(result.body)).toBeUndefined();
    // The documented shape bounds it as the setting does: below the floor, past 64 or as text each fail it.
    const body = result.body as Record<string, unknown>;
    for (const passwordMin of [7, 65, "12"]) expect(await valid({ ...body, passwordMin })).toBeDefined();
  });

  it("reach an agent through get_config, valid against the tool's documented output", async () => {
    await change(CHANGED);
    const tool = buildTools().find(candidate => candidate.name === "get_config")!;
    const result = await executeTool(tool, {}, origin,
      (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch,
      { authorization: `Bearer ${memberToken()}` });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect((result.body as { defaults: unknown }).defaults).toEqual(CHANGED);
    const output = fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0]);
    const valid = async (body: unknown) => (await output["~standard"].validate(mcpResult(tool, { ...result, body }, null).structuredContent)).issues;
    expect(await valid(result.body)).toBeUndefined();
    // The documented shape holds every key and every value's kind: a value
    // off a key's list, a missing key or a stranger each fail it.
    const body = result.body as { defaults: Record<string, unknown> };
    const { ["imageExport.shape"]: shape, ...missing } = body.defaults;
    expect(shape).toBe("1:1");
    for (const defaults of [{ ...body.defaults, "imageExport.shape": "2:1" }, missing, { ...body.defaults, "newMap.pitch": 30 },
      { ...body.defaults, "sqlConsole.lineWrap": "on" }, { ...body.defaults, "newMap.zoom": 23 }]) {
      expect(await valid({ ...body, defaults })).toBeDefined();
    }
  });
});
