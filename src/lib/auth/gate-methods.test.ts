import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken } from "./credentials";
import { gateRequest } from "./gate";

let db: Database, authorization: string;
const request = (path: string, method: string, auth = authorization) => new NextRequest(socketRequest(new Request("http://instance.test" + path, { method, headers: auth ? { authorization: auth } : {} })));
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  const signed = await createFirstAccount({ name: "Ada", email: "ada@example.test", password: "field notebooks at dawn" }, db);
  authorization = `Bearer ${createApiToken(authenticateSession(signed.secret, db)!, "Methods", db).secret}`;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it("refuses wrong methods against the contract for every concrete API path without dispatch or content changes", async () => {
  const content = () => ["maps", "layers", "recipes", "projects", "data_tables", "accounts"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const before = content();
  for (const [path, methods] of Object.entries(buildOpenApiDocument().paths)) {
    const allowed = Object.keys(methods).map(method => method.toUpperCase()).sort();
    expect(allowed, path).toContain("OPTIONS");
    if (allowed.includes("GET")) expect(allowed, path).toContain("HEAD");
    const url = path.replaceAll(/\{[^}]+\}/g, "fixture");
    for (const wrong of ["PUT", "PATCH", "DELETE", "POST", "GET"].filter(method => !allowed.includes(method))) {
      const response = gateRequest(request(url + "?ignored=1", wrong));
      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow")?.split(", ").sort(), path).toEqual(allowed);
      expect(response.headers.get("x-middleware-next")).toBeNull();
      expect(await response.json()).toEqual({ error: { code: "method_not_allowed", message: "This method is not allowed for this path." } });
    }
    const options = gateRequest(request(url, "OPTIONS"));
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")?.split(", ").sort()).toEqual(allowed);
    expect(await options.text()).toBe("");
  }
  expect(content()).toEqual(before);
});

it("preserves unknown URLs, HEAD dispatch and authentication before method facts", async () => {
  for (const path of ["/api/future", "/api/maps/id/extra", "/api/openapiXjson"]) {
    expect(gateRequest(request(path, "PUT")).headers.get("x-middleware-next")).toBe("1");
    expect(gateRequest(request(path, "PUT", "")).status).toBe(401);
  }
  for (const path of ["/api/maps", "/api/health", "/api/published/fixture"]) {
    expect(gateRequest(request(path, "HEAD")).headers.get("x-middleware-next")).toBe("1");
    for (const method of ["PUT", "OPTIONS"]) {
      const refusal = gateRequest(request(path, method, ""));
      expect(refusal.status).toBe(401); expect(refusal.headers.has("allow")).toBe(false);
    }
  }
  const head = gateRequest(request("/api/mcp", "HEAD"));
  expect(head.status).toBe(405); expect(await head.text()).toBe("");
});
