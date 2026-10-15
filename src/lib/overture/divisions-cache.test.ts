import { afterEach, expect, it, vi } from "vitest";
import { listDivisionCountries, resetDivisionCaches } from "./divisions";
import { withConnection } from "@/lib/duckdb";
import { admitTrustedOperation } from "@/lib/trusted-operation";
vi.mock("@/lib/duckdb", () => ({ withConnection: vi.fn() }));
afterEach(() => { resetDivisionCaches(); vi.resetAllMocks(); vi.useRealTimers(); });
it("a failed evicted read cannot remove its successful replacement", async () => {
  const old = Promise.withResolvers<never>(), entered = Promise.withResolvers<void>();
  vi.mocked(withConnection).mockImplementationOnce(() => { entered.resolve(); return old.promise; }).mockResolvedValue([{ code: "DE", name: "Germany", xmin: 1, ymin: 2, xmax: 3, ymax: 4 }]);
  const first = listDivisionCountries("2026-06-17.0").catch(error => error);
  await entered.promise; resetDivisionCaches();
  const replacement = await listDivisionCountries("2026-06-17.0");
  old.reject(new Error("source failed")); await first;
  expect(await listDivisionCountries("2026-06-17.0")).toEqual(replacement);
  expect(withConnection).toHaveBeenCalledTimes(2);
});

it("a later import that finds its countries cached keeps its own deadline", async () => {
  vi.mocked(withConnection).mockResolvedValue([{ code: "DE", name: "Germany", xmin: 1, ymin: 2, xmax: 3, ymax: 4 }]);
  await listDivisionCountries("2026-06-17.0");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const op = admitTrustedOperation({ kind: "import", name: "Overture import", budgetMs: 100 });
  let committed = false;
  const result = op.run(async () => {
    await listDivisionCountries("2026-06-17.0");
    await vi.advanceTimersByTimeAsync(5000);
    op.assertCanCommit(); committed = true;
  }).then(value => ({ value }), error => ({ error }));
  expect(await result).toEqual({ error: expect.objectContaining({ code: "data_processing_timeout" }) });
  expect(committed).toBe(false); expect(withConnection).toHaveBeenCalledTimes(1);
  await op.settled;
});
