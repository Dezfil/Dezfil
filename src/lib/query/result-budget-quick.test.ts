import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupGeometryTest, cleanupGeometryTest } from "@/lib/test-support/geometry";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { probeClient } from "../../../scripts/result-budget-client.mjs";
import { quickReaders } from "../../../scripts/result-budget-readers.mjs";

let directory: string;
beforeEach(async () => { directory = await setupGeometryTest(); });
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await cleanupGeometryTest(directory);
});

it("runs source-free cell boundaries and exact SQL result admission through real routes", async () => {
  vi.stubEnv("DEZFIL_PROBE_TOKEN", "fixture");
  vi.stubEnv("DEZFIL_TEST_PG_URL", "");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    request.headers.delete("authorization");
    return dispatchAssistantTestRoute(request);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const client = await probeClient("http://localhost:3307", "quick-route-control");
  const observed: { tag: string; status: number; bytes: number; cell?: number }[] = [];
  const read = client.read;
  client.read = async (...args: Parameters<typeof read>) => {
    const answer = await read(...args);
    const value = args[2] === "geometry-choice" ? answer.body?.sample?.rows[0].values.v : answer.body?.preview?.[0].v;
    observed.push({ tag: args[2], status: answer.status, bytes: answer.bytes,
      ...(value === undefined ? {} : { cell: Buffer.byteLength(JSON.stringify(value)) }) });
    return answer;
  };
  try {
    await quickReaders(client);
    for (const tag of ["SQL GeoJSON", "SQL WKT", "inspection", "geometry-choice"]) {
      expect(observed.filter(row => row.tag === tag).map(row => [row.status, row.cell])).toEqual([
        [200, 2097151], [200, 2097152], [422, undefined],
      ]);
    }
    const sql = observed.filter(row => row.tag === "SQL admission");
    expect(sql.at(-1)).toEqual({ tag: "SQL admission", status: 200, bytes: 33554432, cell: 1000002 });
    expect(client.owned).toEqual([]);
  } finally { await client.cleanup(); }
}, 60_000);
