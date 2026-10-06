import { expect, it, vi } from "vitest";
import { settingsProbe, probeOrigin } from "../../../scripts/settings-probe.mjs";

const base = "http://127.0.0.1:3396";
function fixture(defect = "", existing = false) {
  const initial = { previewRows: existing ? 17 : null, signInMessage: existing ? "Existing message" : null };
  let stored = { ...initial }, restarted = false, writes = 0, reads = 0;
  const calls: string[] = [];
  const effective = () => ({ previewRows: stored.previewRows ?? 1000, signInMessage: stored.signInMessage ?? "" });
  const document = () => ({ startedAt: restarted && defect !== "same-start" ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
    settings: Object.fromEntries(Object.entries(effective()).map(([key, value]) => [key, { value,
      storedValue: stored[key as keyof typeof stored], source: stored[key as keyof typeof stored] === null ? "default" : "stored", locked: defect === "locked" && key === "previewRows" }])) });
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("authorization")).toBe(path === "/api/auth/entry" ? null : "Bearer fixture-token");
    calls.push(`${method} ${path}`);
    if (path === "/api/instance/settings") {
      if (method === "PATCH") {
        writes++;
        if (defect === "cleanup" && writes === 2) return Response.json({}, { status: 500 });
        const body = JSON.parse(String(init?.body));
        expect(Object.keys(body).sort()).toEqual(["previewRows", "signInMessage"]);
        stored = { ...stored, ...body };
        if (defect === "partial" && writes === 1) stored.signInMessage = initial.signInMessage;
      }
      const result = document();
      if (defect === "unstable-start" && method === "GET" && ++reads > 1) result.startedAt = "2026-01-03T00:00:00.000Z";
      return Response.json(result);
    }
    const stale = writes === 1 && defect === "stale-config";
    if (path === "/api/config") return Response.json({ previewRows: stale ? 1000 : effective().previewRows });
    if (path === "/api/auth/entry") return Response.json({ signInMessage: effective().signInMessage });
    if (path === "/api/query") {
      expect(JSON.parse(String(init?.body))).toEqual({ sql: "SELECT range AS n FROM range(25) ORDER BY n" });
      const length = Math.min(writes === 1 && defect === "stale-query" ? 1000 : effective().previewRows, 25);
      // range() produces BIGINT values, which the query route serializes as strings.
      return Response.json({ rowCount: defect === "wrong-count" ? length : 25,
        preview: Array.from({ length }, (_, n) => ({ n: String(n) })), previewTruncated: defect === "wrong-truncation" ? false : length < 25 });
    }
    throw new Error(`Unexpected path: ${path}`);
  });
  const restart = vi.fn(async () => {
    restarted = true;
    if (defect === "lost-store") stored = { previewRows: null, signInMessage: null };
  });
  return { initial, stored: () => stored, calls, writes: () => writes, fetchImpl, restart };
}
const run = (f: ReturnType<typeof fixture>) => settingsProbe(base, {
  token: "fixture-token", restart: f.restart, fetchImpl: f.fetchImpl, restartWaitMs: 0,
});

it.each([false, true])("warms other routes, checks a multi-key write and restart, and restores existing=%s overrides", async existing => {
  const f = fixture("", existing), result = await run(f);
  expect(result).toMatchObject({ result: "confirmed", previewRows: 10, startedAtBefore: "2026-01-01T00:00:00.000Z", startedAtAfter: "2026-01-02T00:00:00.000Z", restored: true });
  expect(f.restart).toHaveBeenCalledOnce();
  expect(f.writes()).toBe(2);
  expect(f.stored()).toEqual(f.initial);
  const firstWrite = f.calls.indexOf("PATCH /api/instance/settings");
  expect(f.calls.slice(0, firstWrite)).toContain("GET /api/config");
  expect(f.calls.slice(0, firstWrite)).toContain("POST /api/query");
});

it.each([
  ["stale-config", "configuration consumer"], ["stale-query", "query preview"],
  ["partial", "signInMessage"], ["lost-store", "previewRows"],
  ["same-start", "start time did not change"], ["unstable-start", "start time must be stable"],
  ["wrong-count", "full query row count"], ["wrong-truncation", "query truncation"],
  ["locked", "previewRows must be unlocked"], ["cleanup", "HTTP 500"],
])("rejects the %s defect instead of reporting green", async (defect, message) => {
  const f = fixture(defect);
  await expect(run(f)).rejects.toThrow(message);
  if (!["cleanup", "locked", "unstable-start", "wrong-count"].includes(defect)) expect(f.stored()).toEqual(f.initial);
  if (["locked", "unstable-start"].includes(defect)) { expect(f.writes()).toBe(0); expect(f.restart).not.toHaveBeenCalled(); }
});

it.each(["http://127.0.0.1:3000", "https://example.test:3396", "http://user:password@localhost:3396", "http://localhost:3396/path", "http://localhost:3396?token=x", "http://localhost"])("refuses an unsuitable probe target %s", origin => {
  expect(() => probeOrigin(origin)).toThrow();
});
it("accepts explicit isolated loopback ports", () => {
  for (const origin of [base, "http://localhost:3397", "http://[::1]:3398"]) expect(probeOrigin(origin)).toBe(origin);
});
it("requires an admin token and a restart callback before sending requests", async () => {
  const f = fixture();
  await expect(settingsProbe(base, { token: "", restart: f.restart, fetchImpl: f.fetchImpl })).rejects.toThrow("DEZFIL_PROBE_TOKEN");
  await expect(settingsProbe(base, { token: "fixture-token", fetchImpl: f.fetchImpl })).rejects.toThrow("restart");
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
