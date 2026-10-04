import { describe, expect, it } from "vitest";
import { assertClosed, evidence } from "../../../scripts/held-provider.mjs";
import { assertNormal } from "../../../scripts/provider-cancel-probe.mjs";

// These test the observer's refusal of bad evidence, not a socket lifetime.
describe("provider probe observer", () => {
  const arm = (closedAt: number | null, cleanup = false) => ({ id: "search:body", held: true, requests: [{ hop: 0, arrivedAt: 0, closedAt, cleanup }] });
  it("rejects missing observation, late closure and teardown-supplied closure", async () => {
    await expect(assertClosed({ ...arm(100), held: null }, 10)).rejects.toThrow("held destination");
    await expect(assertClosed(arm(1_011), 10)).rejects.toThrow("limit 1000 ms");
    await expect(assertClosed(arm(100, true), 10)).rejects.toThrow("teardown cannot prove");
    await expect(assertClosed(arm(1_010), 10)).resolves.toBeUndefined();
  });
  it("emits timing evidence without socket objects", () => {
    expect(evidence(arm(null))).toEqual([{ hop: 0, arrivedAt: 0, closedAt: null, cleanup: false }]);
  });
  it("rejects an empty or unattributed successful place result", () => {
    expect(() => assertNormal("search", { status: 200, body: { places: { state: "ok", results: [] } } })).toThrow();
    expect(() => assertNormal("inspect", { status: 200, body: { verdict: "valid" } })).toThrow();
  });
});
