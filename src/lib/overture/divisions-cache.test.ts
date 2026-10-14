import { afterEach, expect, it, vi } from "vitest";
import { listDivisionCountries, resetDivisionCaches } from "./divisions";
import { withConnection } from "@/lib/duckdb";
vi.mock("@/lib/duckdb", () => ({ withConnection: vi.fn() }));
afterEach(() => { resetDivisionCaches(); vi.resetAllMocks(); });
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
