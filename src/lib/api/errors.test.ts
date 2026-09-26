import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, errorResponse } from "./errors";
import { ERROR_CATALOGUE, publishedMessage } from "./error-catalogue";

/**
 * The error-to-response boundary: an unexpected failure answers with the
 * documented internal sentence — never its own message, which carries
 * filesystem paths, the key-file location, and engine text. The detail
 * stays in the server log.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorResponse", () => {
  it("a coded error passes through: code, message, status", async () => {
    const res = errorResponse(new ApiError("not_found", "No such map.", 404));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toEqual({ code: "not_found", message: "No such map." });
  });

  it("an unexpected failure answers the documented sentence, never its own", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error(
      "ENOENT: no such file or directory, open '/data/dezfil/secret.key'",
    );
    const res = errorResponse(raw);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toBe(ERROR_CATALOGUE.internal);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("secret.key");
    expect(wire).not.toContain("/data");
    expect(wire).not.toContain("ENOENT");
    // The administrator keeps the detail — in the log, not on the wire.
    expect(log).toHaveBeenCalledWith("[api] unexpected error:", raw);
  });

  it("a non-Error throw answers the same documented sentence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse("string failure with /an/absolute/path");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe(ERROR_CATALOGUE.internal);
    expect(JSON.stringify(body)).not.toContain("/an/absolute/path");
  });
});

describe("publishedMessage", () => {
  it("a documented code yields exactly its catalogue sentence", () => {
    expect(publishedMessage("sql_error")).toBe(ERROR_CATALOGUE.sql_error);
    expect(publishedMessage("tile_build_failed")).toBe(
      ERROR_CATALOGUE.tile_build_failed,
    );
    expect(publishedMessage("tiler_unavailable")).toBe(
      ERROR_CATALOGUE.tiler_unavailable,
    );
  });

  it("an unknown code falls back to the internal sentence, leaking nothing", () => {
    expect(publishedMessage("no_such_code")).toBe(ERROR_CATALOGUE.internal);
  });
});
