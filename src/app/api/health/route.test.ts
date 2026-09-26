import { describe, it, expect, vi, afterEach } from "vitest";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { GET } from "./route";

/**
 * The readiness boundary keeps promise too: an unusable data directory
 * answers a documented reason — never the failure's own message, which
 * carries the configured absolute data path.
 */

vi.mock("@/lib/data-dir", () => ({
  ensureDataDir: () =>
    Promise.reject(
      new Error(
        "EACCES: permission denied, mkdir '/srv/volumes/dezfil-data'",
      ),
    ),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("health route failure disclosure", () => {
  it("answers 503 with a documented reason and no path", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unready");
    expect(body.reason).toBe(ERROR_CATALOGUE.internal);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("/srv");
    expect(wire).not.toContain("EACCES");
    expect(log).toHaveBeenCalled();
  });
});
