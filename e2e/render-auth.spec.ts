import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";

// Requires the isolated server's renderer and an authenticated page fixture.
// Both loopback trap ports must be admitted by its egress allowlist.
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP48OHDfwAJdAPQXHvArAAAAABJRU5ErkJggg==", "base64");
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

test("cookie and token renders survive redirects without sending credentials to basemap hosts", async ({ page, playwright, baseURL }) => {
  test.setTimeout(180_000);
  const seen: { path: string; authorization?: string; cookie?: string }[] = [];
  let firstOrigin = "", secondOrigin = "";
  const first = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push({ path, authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.writeHead(307, { "access-control-allow-origin": "*", location: secondOrigin + (path === "/entry.json" ? "/style.json" : path) }); response.end();
  });
  const second = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push({ path, authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.writeHead(200, { "access-control-allow-origin": "*", "cache-control": "no-store", "content-type": path === "/style.json" ? "application/json" : "image/png" });
    response.end(path === "/style.json" ? JSON.stringify({ version: 8, sources: { fixture: { type: "raster", tiles: [firstOrigin + "/tiles/{z}/{x}/{y}.png"], tileSize: 512 } }, layers: [{ id: "fixture", type: "raster", source: "fixture" }] }) : tile);
  });
  firstOrigin = await listen(first); secondOrigin = await listen(second);
  const headers = { origin: new URL(baseURL!).origin };
  const api = page.request;
  let mapId: string | undefined, tokenId: string | undefined;
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const created = await api.post("/api/maps", { headers, data: { name: "Authenticated render" } }); expect(created.status()).toBe(201);
    const map = await created.json(); mapId = map.id;
    expect((await api.patch(`/api/maps/${mapId}`, { headers, data: { customBasemap: { url: firstOrigin + "/entry.json", name: "Redirect fixture", attribution: [{ label: "Fixture" }] } } })).status()).toBe(200);
    const issued = await api.post("/api/account/tokens", { headers, data: { name: "Render browser proof" } }); expect(issued.status()).toBe(201);
    const token = await issued.json(); tokenId = token.id;
    const bearer = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token.secret}` }, storageState: { cookies: [], origins: [] } });
    const definition = { viewport: { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 }, size: { width: 512, height: 256 }, mapScale: 1, legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light" };
    try {
      expect((await anonymous.post(`/api/maps/${mapId}/export/image`, { headers, data: { definition } })).status()).toBe(401);
      expect((await anonymous.post("/api/maps/look", { headers, data: { mapId } })).status()).toBe(401);
      expect((await anonymous.get(`/render/${mapId}`, { maxRedirects: 0 })).status()).toBe(307);
      for (const client of [api, bearer]) {
        const start = seen.length;
        const image = await client.post(`/api/maps/${mapId}/export/image`, { headers, data: { definition } });
        expect(image.status()).toBe(200); expect(image.headers()["cache-control"]).toBe("private, no-store");
        expect((await image.body()).subarray(1, 4).toString()).toBe("PNG");
        const look = await client.post("/api/maps/look", { headers, data: { mapId } }); expect(look.status()).toBe(200);
        const result = await look.json(); expect(result.render.composition.failures).toEqual([]);
        expect(JSON.stringify(result.render)).not.toContain(token.secret); expect(JSON.stringify(result.render)).not.toContain("dz_delegation_");
        const retained = await client.get(`/api/maps/look/${result.render.id}`); expect(retained.status()).toBe(200);
        expect(await retained.body()).toEqual(Buffer.from(result.image.content_base64, "base64"));
        expect((await anonymous.get(`/api/maps/look/${result.render.id}`)).status()).toBe(401);
        const traffic = seen.slice(start);
        expect(traffic.some(value => value.path === "/entry.json")).toBe(true);
        expect(traffic.some(value => value.path === "/style.json")).toBe(true);
        expect(traffic.some(value => value.path.startsWith("/tiles/"))).toBe(true);
        for (const request of traffic) { expect(request.authorization).toBeUndefined(); expect(request.cookie).toBeUndefined(); }
      }
      expect((await api.delete(`/api/account/tokens/${tokenId}`, { headers })).status()).toBe(200); tokenId = undefined;
      expect((await bearer.post("/api/maps/look", { data: { mapId } })).status()).toBe(401);
    } finally { await bearer.dispose(); }
  } finally {
    if (tokenId) await api.delete(`/api/account/tokens/${tokenId}`, { headers });
    if (mapId) await api.delete(`/api/maps/${mapId}`, { headers });
    await anonymous.dispose(); await Promise.all([close(first), close(second)]);
  }
});
