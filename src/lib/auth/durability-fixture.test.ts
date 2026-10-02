import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";

vi.mock("../../../scripts/journey-auth.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../../../scripts/journey-auth.mjs")>(),
  provisionJourney: async () => ({ token: "fixture-token", cookie: "fixture-cookie", account: { id: "owner" } }),
}));
afterEach(() => vi.unstubAllGlobals());

it("chains the durability seed's layer and publication through accepted revisions", async () => {
  const dir = await mkdtemp(`${process.cwd()}/.claude/test-data/durability-`);
  const argv = process.argv;
  const covered: string[] = [];
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/maps/map/layers" || pathname === "/api/maps/map/publish") {
      covered.push(pathname);
      const expected = pathname.endsWith("layers") ? "created-revision" : "layer-revision";
      expect(request.headers.get("X-Edit-Revision")).toBe(expected);
      return Response.json(pathname.endsWith("layers") ? { id: "layer", editRevision: "layer-revision" } : { token: "publication", editRevision: "published-revision" }, { status: 201 });
    }
    if (pathname === "/api/maps") return Response.json({ id: "map", editRevision: "created-revision" }, { status: 201 });
    if (pathname === "/api/tables") return Response.json({ name: "durability" }, { status: 201 });
    if (pathname === "/api/account/tokens" && request.method === "POST") return Response.json({ id: "revoked", secret: "revoked-token" }, { status: 201 });
    return Response.json({});
  });
  try {
    process.argv = ["node", "durability.mjs", "seed", "http://fixture.test", `${dir}/state.json`];
    await import("../../../scripts/durability.mjs");
    expect(covered).toEqual(["/api/maps/map/layers", "/api/maps/map/publish"]);
  } finally {
    process.argv = argv;
    await rm(dir, { recursive: true, force: true });
  }
});
