import { expect, it } from "vitest";
import { named, ownConnection } from "../../../scripts/journey-http.mjs";

const refused = async () => { throw new TypeError("fetch failed", { cause: new Error("other side closed") }); };

it("names the request and the JSON-RPC call that got no answer, keeping the cause", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_map", arguments: {} } });
  const failure = await named(refused)("http://127.0.0.1:3383/api/mcp", { method: "POST", body }).catch(error => error);
  expect(failure.message).toBe("POST /api/mcp (tools/call get_map) got no answer: other side closed");
  expect(failure.cause).toBeInstanceOf(TypeError);
  await expect(named(refused)(new URL("http://127.0.0.1:3383/api/maps"))).rejects.toThrow("GET /api/maps got no answer: other side closed");
});

it("passes an answer through untouched", async () => {
  const answer = new Response("{}", { status: 201 });
  expect(await named(async () => answer)("http://127.0.0.1:3383/api/maps", { method: "POST", body: "{}" })).toBe(answer);
});

it("asks every exchange for a connection of its own, keeping its headers", async () => {
  const seen: Headers[] = [];
  const send = ownConnection(async (_url: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response(null, { status: 204 }); });
  await send("http://127.0.0.1:3383/api/mcp", { method: "POST", headers: { authorization: "Bearer journey", connection: "keep-alive" }, body: "{}" });
  await send(new Request("http://127.0.0.1:3383/api/mcp", { headers: { "mcp-protocol-version": "2025-06-18" } }));
  expect(seen.map(headers => headers.get("connection"))).toEqual(["close", "close"]);
  expect(seen[0].get("authorization")).toBe("Bearer journey");
  expect(seen[1].get("mcp-protocol-version")).toBe("2025-06-18");
});
