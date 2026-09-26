import { expect, it, vi } from "vitest";
import type { DataTable } from "@/lib/metadata/tables";
import { inspectionCache } from "./inspection-cache";

const table = (id = "a", file = "first"): DataTable => ({ id, file } as DataTable);
it("failed reads are retried; returned candidates cannot mutate the cached answer", async () => {
  const cache = inspectionCache<{ columns: string[] }>();
  const read = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue({columns:["a","b"]});
  await expect(cache(table(), read)).rejects.toThrow("disk unavailable");
  const answer = await cache(table(), read);
  answer.columns.pop();
  expect(await cache(table(), read)).toEqual({columns:["a","b"]});
  expect(read).toHaveBeenCalledTimes(2);
});
it("a late failed old artifact cannot evict its replacement; reclaimed identities read anew", async () => {
  const cache = inspectionCache<string>();
  let reject!: (e: Error) => void;
  const pending = cache(table(), () => new Promise((_resolve, fail) => { reject = fail; }));
  const newer = vi.fn(async () => "second");
  expect(await cache(table("a", "second"), newer)).toBe("second");
  reject(new Error("old artifact"));
  await expect(pending).rejects.toThrow("old artifact");
  expect(await cache(table("a", "second"), newer)).toBe("second");
  expect(newer).toHaveBeenCalledTimes(1);
  expect(await cache(table("reclaimed", "second"), newer)).toBe("second");
  expect(newer).toHaveBeenCalledTimes(2);
});
