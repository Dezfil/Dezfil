import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

afterEach(() => vi.restoreAllMocks());
it("refuses readiness without socket provenance even if a caller supplies forwarding and internal headers", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await GET(new Request("http://localhost/api/health", { headers: {
    "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https",
    "x-dezfil-ingress": "caller-supplied",
  } }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unready", reason: "An unexpected server error occurred." });
});
