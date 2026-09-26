import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";

const previewPostgis = vi.hoisted(() => vi.fn());
vi.mock("@/lib/postgis/preview", () => ({ previewPostgis }));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/connections/postgis/c1/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/connections/postgis/{id}/preview", () => {
  beforeEach(() => {
    previewPostgis.mockReset();
  });

  it("returns columns independently from zero matching rows", async () => {
    previewPostgis.mockResolvedValue({
      columns: [{ name: "id", type: "int4", spatialKind: null }],
      rows: [],
    });
    const response = await POST(
      request({ schema: "public", table: "roads", filter: "false" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      columns: [{ name: "id", type: "int4", spatialKind: null }],
      rows: [],
    });
    expect(previewPostgis).toHaveBeenCalledWith("c1", {
      schema: "public",
      table: "roads",
      filter: "false",
    }, undefined, expect.any(AbortSignal));
  });

  it("returns the guard's exact refusal", async () => {
    previewPostgis.mockRejectedValue(
      new ApiError(
        "invalid_request",
        "The filter must be a single WHERE expression: no statement separators or comments.",
        400,
      ),
    );
    const response = await POST(
      request({ schema: "public", table: "roads", filter: "true; SELECT 1" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain(
      "The filter must be a single WHERE expression: no statement separators or comments.",
    );
  });

  it("projects unexpected failures without echoing credentials", async () => {
    const secret = "distinctive-route-secret";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    previewPostgis.mockRejectedValue(
      new Error(`source failure carrying ${secret}`),
    );
    const response = await POST(
      request({ schema: "public", table: "roads" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("An unexpected server error occurred.");
    expect(text).not.toContain(secret);
    expect(log).toHaveBeenCalledWith(
      "[api] unexpected error:",
      expect.objectContaining({ message: expect.stringContaining(secret) }),
    );
    log.mockRestore();
  });
});
