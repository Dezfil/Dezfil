import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "./route";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

/**
 * A builder route's unexpected-failure boundary: a non-coded failure
 * behind the route answers the documented internal sentence — no path,
 * no key-file location, no engine text on the wire — with the detail in
 * the server log.
 */

vi.mock("@/lib/table-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table-service")>();
  return {
    ...actual,
    listTablesWithSize: () =>
      Promise.reject(
        new Error(
          "SQLITE_CANTOPEN: unable to open database file at /data/dezfil/metadata.sqlite",
        ),
      ),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("builder route unexpected failure", () => {
  it("answers 500 with the documented sentence and no internals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(new Request("http://dezfil.test/api/tables"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toBe(ERROR_CATALOGUE.internal);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("/data");
    expect(wire).not.toContain("metadata.sqlite");
    expect(wire).not.toContain("SQLITE_CANTOPEN");
    expect(log).toHaveBeenCalled();
  });
});
