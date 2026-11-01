import { afterEach, expect, it, vi } from "vitest";
import { errorResponse } from "@/lib/api/errors";
import { authFailure } from "@/lib/auth/http";
import { isStorageExhausted } from "./storage-errors";

afterEach(() => vi.restoreAllMocks());
it.each([
  Object.assign(new Error("write failed"), { code: "ENOSPC" }),
  Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
  new Error('IO Error: Could not write file "private/path": No space left on device'),
])("names a refused destination write through both funnels: %s", async error => {
  for (const funnel of [errorResponse, authFailure]) {
    const answer = funnel(error);
    expect(answer.status).toBe(507);
    expect((await answer.json()).error).toMatchObject({ code: "storage_exhausted" });
  }
});
it.each(["EACCES", "EROFS", "EIO"])("keeps %s internal", async code => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const funnel of [errorResponse, authFailure]) {
    const answer = funnel(Object.assign(new Error("private/path"), { code }));
    expect(answer.status).toBe(500);
    expect(await answer.text()).not.toContain("private/path");
  }
});
it("does not classify arbitrary source text as a destination write", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(errorResponse(new Error("Invalid CSV: no space left on device")).status).toBe(500);
});

it.each([
  'IO Error: Could not open file "no space left on device.shp": No such file or directory',
  'IO Error: Could not open file "no space left on device.shp": not recognized as a supported file format.',
  'IO Error: Could not write file "data": Invalid data: no space left on device in row 1',
])("does not classify file names or data as exhaustion: %s", message => {
  expect(isStorageExhausted(new Error(message))).toBe(false);
});
