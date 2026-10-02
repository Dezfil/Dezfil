import { afterEach, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { browserApi, captureBrowserBasis, readThenWriteBrowserSetup } from "../../../e2e/edit-basis";

// Exercise the browser callback and transport without launching a browser.
const page = { evaluate: async (callback: (args: unknown) => unknown, args: unknown) => callback(args) } as unknown as Page;
afterEach(() => vi.restoreAllMocks());

it("forms named setup intent after the read and carries that exact revision", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
    calls.push({ path: String(path), init });
    return Response.json(init?.method === "GET" ? { name: "Shown", editRevision: "read-basis" } : { editRevision: "accepted" });
  });
  const result = await readThenWriteBrowserSetup(page, "/api/maps/m", (shown) => {
    expect(calls).toHaveLength(1);
    return { method: "PATCH", path: "/api/maps/m", body: { name: `${shown.name} edited` } };
  });
  expect(calls).toHaveLength(2);
  expect(new Headers(calls[1].init?.headers).get("X-Edit-Revision")).toBe("read-basis");
  expect(JSON.parse(String(calls[1].init?.body))).toEqual({ name: "Shown edited" });
  expect(result.json.editRevision).toBe("accepted");
});

it("keeps a stale capture across an interleaving without a hidden read or retry", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ editRevision: "old" }))
    .mockResolvedValueOnce(Response.json({ editRevision: "new" }))
    .mockResolvedValueOnce(Response.json({ error: { code: "stale_revision" } }, { status: 409 }));
  const basis = await captureBrowserBasis(page, "/api/maps/m");
  await browserApi(page, "PATCH", "/api/maps/m", { name: "Intervening" }, basis);
  const stale = await browserApi(page, "PATCH", "/api/maps/m", { name: "Older intent" }, basis);
  expect(stale.status).toBe(409);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(new Headers(fetcher.mock.calls[2][1]?.headers).get("X-Edit-Revision")).toBe("old");
});
