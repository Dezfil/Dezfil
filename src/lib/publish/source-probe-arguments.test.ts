import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPublicationSourceProbe } from "../../../scripts/publication-source-probe.mjs";
import { assertPublicationState, publicationRequest } from "../../../scripts/publication-probe-support.mjs";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));
vi.mock("../../../scripts/journey-auth.mjs", () => ({ provisionJourney: async () => ({ token: "fixture" }) }));
vi.mock("../../../scripts/journey-http.mjs", () => ({
  journeyApi: () => async (method: string) => ({ status: method === "POST" ? 201 : 200, json: { id: "map", editRevision: 1, token: "publication" } }),
}));
vi.mock("../../../scripts/publication-probe-support.mjs", async original => {
  const support = await original<typeof import("../../../scripts/publication-probe-support.mjs")>();
  return { ...support, assertPublicationState: vi.fn(support.assertPublicationState), publicationRequest: vi.fn() };
});

const args = ["http://instance.test:3394", "trusted", "--state-log", "publication.ndjson"];
let peak: number, burst: number;
beforeEach(() => {
  vi.clearAllMocks();
  peak = 8200; burst = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  const statuses = [200, 200, 404, 404, 429, 429, 429, 429, 404, 404, 429, 404, 429, 400, 200];
  vi.mocked(publicationRequest).mockImplementation(async (_base, _pathname, options) => {
    if (options?.headers?.["x-forwarded-for"]?.startsWith("203.0.113.99, 10.")) burst++;
    const status = statuses.shift() ?? 404;
    return { status, headers: { "cache-control": "private, no-store" }, text: "", json: status === 429
      ? { error: { code: "rate_limited", message: "Too many requests. Please slow down." } } : {} };
  });
  vi.mocked(readFile).mockImplementation(async () => [
    { phase: "boot" }, { phase: "publication", size: 1 },
    ...Array.from({ length: burst }, (_, i) => ({ phase: "publication", size: Math.min(i + 2, peak) })),
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
});
afterEach(() => vi.restoreAllMocks());

it("runs the trusted checks without a burst, capacity assertions or capacity evidence by default", async () => {
  const result = await runPublicationSourceProbe(args);
  expect(burst).toBe(0);
  expect(publicationRequest).toHaveBeenCalledTimes(15);
  expect(delay).toHaveBeenCalledExactlyOnceWith(10_050);
  expect(assertPublicationState).not.toHaveBeenCalled();
  expect(result.evidence).toEqual(Array.from({ length: 14 }, () => ({ suffix: expect.any(String), status: expect.any(Number) })));
  expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result));
  expect(JSON.stringify(result)).not.toMatch(/capacity|statePeak|\bcap\b|10000/);
});

it("fails under --capacity when all burst admissions stay below the bound", async () => {
  await expect(runPublicationSourceProbe([...args, "--capacity"])).rejects.toThrow("capacity arm never reached the bound; expiry may have hidden eviction");
  expect(burst).toBe(10_050);
  expect(assertPublicationState).toHaveBeenCalledWith(expect.any(Array), 10_050, true);
  expect(console.log).not.toHaveBeenCalled();
});

it("reports capacity evidence only after the flagged burst reaches and retains the bound", async () => {
  peak = 10_000;
  const result = await runPublicationSourceProbe([...args.slice(0, 2), "--capacity", ...args.slice(2)]);
  expect(burst).toBe(10_050);
  expect(result.evidence.at(-1)).toEqual({ statePeak: 10_000, cap: 10_000 });
  expect(assertPublicationState).toHaveBeenCalledWith(expect.any(Array), 10_050, true);
});

it.each(["direct", "untrusted", "missing"])("refuses --capacity for %s instead of silently omitting the requested proof", async mode => {
  await expect(runPublicationSourceProbe([args[0], mode, ...args.slice(2), "--capacity"])).rejects.toThrow("--capacity requires trusted mode");
  expect(publicationRequest).not.toHaveBeenCalled();
});
