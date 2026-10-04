import { expect, it, vi } from "vitest";
import { POST } from "./route";
const { inspectStyle } = vi.hoisted(() => ({ inspectStyle: vi.fn() }));
vi.mock("@/lib/net/inspect-style", () => ({ inspectStyle }));
it("carries advisory caller cancellation to inspection", async () => {
  inspectStyle.mockResolvedValue({ verdict: "not_style", detail: "Not a style." });
  const request = new Request("http://test/api/basemap/inspect", { method: "POST", body: JSON.stringify({ url: "https://fixture.test/style" }), signal: new AbortController().signal });
  expect((await POST(request)).status).toBe(200);
  expect(inspectStyle).toHaveBeenCalledWith("https://fixture.test/style", undefined, request.signal);
});
