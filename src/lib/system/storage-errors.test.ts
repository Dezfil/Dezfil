import { afterEach, expect, it, vi } from "vitest";
import { errorResponse } from "@/lib/api/errors";
import { authFailure } from "@/lib/auth/http";
import { isStorageExhausted, rethrowStorageFailure } from "./storage-errors";
import { trustedEngineError } from "@/lib/trusted-connection";

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

it.each(["Permission denied", "Operation not permitted", "Read-only file system", "Input/output error"])("maps native %s to internal before format wrappers", reason => {
  const error = new Error(`IO Error: Cannot open file "destination": ${reason}`);
  expect(() => rethrowStorageFailure(error)).toThrow(expect.objectContaining({ code: "internal", status: 500 }));
  expect(trustedEngineError(error)).toMatchObject({ code: "internal", status: 500 });
});

it.each(["Permission denied", "Operation not permitted", "Read-only file system", "Input/output error"])("ignores %s in filenames and data", reason => {
  for (const message of [
    `IO Error: Could not open file "${reason}.shp": No such file or directory`,
    `Invalid CSV: ${reason}`,
  ]) {
    const error = new Error(message);
    expect(() => rethrowStorageFailure(error)).not.toThrow();
    expect(trustedEngineError(error)).toBe(error);
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
