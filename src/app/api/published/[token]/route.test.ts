import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "./route";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

/**
 * The published view route's unexpected-failure boundary: a non-coded
 * failure behind the anonymous route answers the documented internal
 * sentence — no path, no engine text — identically to the builder
 * boundary. The per-layer errored envelopes' disclosure lives with the
 * service tests (publish.test.ts) and the per-lane route tests; this
 * file drives the route's own 500 shape.
 */

vi.mock("@/lib/publish/publish-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/publish/publish-service")>();
  return {
    ...actual,
    getPublishedView: () =>
      Promise.reject(
        new Error(
          "IO Error: could not read '/Users/op/dezfil/data/tables/t.parquet'",
        ),
      ),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("published route unexpected failure", () => {
  it("answers 500 with the documented sentence and no internals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = "t".repeat(22);
    const res = await GET(
      socketRequest(new Request(`http://localhost/api/published/${token}`)),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toBe(ERROR_CATALOGUE.internal);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("/Users");
    expect(wire).not.toContain(".parquet");
    expect(wire).not.toContain("IO Error");
    expect(log).toHaveBeenCalled();
  });
});
