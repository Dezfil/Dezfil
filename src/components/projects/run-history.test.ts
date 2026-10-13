import { afterEach, describe, expect, it, vi } from "vitest";
import { readHome } from "./home-read";
import { readLastRun } from "./run-history";

/**
 * A workflow's run history, as its card's time fact reads it: the start of
 * the first run the history lists (the newest), null when it lists none,
 * and "unreadable" when the history cannot be read, whether the server
 * refuses, the connection fails or the answer cannot be read; never an
 * invented time. One read per workflow, never cached, and a history that
 * fails fails nothing else.
 */

const RUNS: Record<string, () => Promise<Response>> = {
  "w-ran": async () => Response.json({ runs: [{ startedAt: "2026-10-02T14:00:00Z" }, { startedAt: "2026-10-01T09:00:00Z" }] }),
  "w-never": async () => Response.json({ runs: [] }),
  "w-refused": async () => Response.json({ error: { code: "forbidden", message: "You can't read this workflow's runs." } }, { status: 403 }),
  "w-cut": async () => { throw new TypeError("Failed to fetch"); },
  "w-garbled": async () => new Response('{"runs":', { status: 200, headers: { "content-type": "application/json" } }),
};
const WORKFLOWS = Object.keys(RUNS).map((id) => ({ id, name: id, steps: [], summary: { status: "up_to_date", count: 0 } }));

const requests: { path: string; init?: RequestInit }[] = [];
function serve() {
  requests.length = 0;
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    const runs = /^\/api\/recipes\/([^/?]+)\/runs$/.exec(path);
    if (runs) return RUNS[runs[1]]();
    if (path === "/api/projects/p") return Response.json({ id: "p", name: "Atlas", note: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    if (path === "/api/recipes?origin=workflow&project=p") return Response.json({ recipes: WORKFLOWS });
    if (path === "/api/projects") return Response.json([{ id: "p", name: "Atlas" }]);
    return Response.json([]);
  });
}
afterEach(() => vi.unstubAllGlobals());

const EXPECTED = new Map<string, string | null>([
  ["w-ran", "2026-10-02T14:00:00Z"],
  ["w-never", null],
  ["w-refused", "unreadable"],
  ["w-cut", "unreadable"],
  ["w-garbled", "unreadable"],
]);

describe("the project home's read of each workflow's runs", () => {
  it("gives the newest listed start, null for none, and unreadable for a refused, cut or garbled read", async () => {
    serve();
    const state = await readHome("p");
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.value.lastRuns).toEqual(EXPECTED);
    expect(state.value.workflows.map((w) => w.id)).toEqual([...EXPECTED.keys()]);
  });

  it("asks once per workflow, never from the cache", async () => {
    serve();
    await readHome("p");
    const reads = requests.filter((r) => r.path.endsWith("/runs"));
    expect(reads.map((r) => r.path)).toEqual([...EXPECTED.keys()].map((id) => `/api/recipes/${id}/runs`));
    expect(reads.map((r) => r.init?.cache)).toEqual(Array(EXPECTED.size).fill("no-store"));
  });
});

describe("the shared read of a workflow's runs", () => {
  it.each([...EXPECTED])("reads %s as %s", async (id, expected) => {
    serve();
    expect(await readLastRun(id)).toBe(expected);
    expect(requests.map((r) => [r.path, r.init?.cache])).toEqual([[`/api/recipes/${id}/runs`, "no-store"]]);
  });
});
