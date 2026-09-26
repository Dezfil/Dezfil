import { describe, it, expect } from "vitest";
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/icons/sanitize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("advisory icon sanitize endpoint", () => {
  it("answers the sanitizer's verdict for clean and dirty SVG", async () => {
    const clean =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4"/></svg>';
    const res = await post({ svg: clean });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { svg: string; changed: boolean };
    expect(body.svg).toBe(clean);
    expect(body.changed).toBe(false);

    const dirty = await post({
      svg: '<svg viewBox="0 0 4 4"><path d="M0 0h4" onclick="x()"/></svg>',
    });
    const report = (await dirty.json()) as {
      changed: boolean;
      dropped: { name: string }[];
    };
    expect(report.changed).toBe(true);
    expect(report.dropped.map((d) => d.name)).toContain("onclick");
  });

  it("rejects malformed bodies and non-SVG input with invalid_request", async () => {
    expect((await post("null")).status).toBe(400);
    expect((await post("not json{{")).status).toBe(400);
    expect((await post({ svg: 42 })).status).toBe(400);
    const hostileOnly = await post({
      svg: '<svg viewBox="0 0 1 1"><script>x</script></svg>',
    });
    expect(hostileOnly.status).toBe(400);
  });
});
