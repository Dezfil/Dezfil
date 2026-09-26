import { describe, expect, it } from "vitest";
import { timeSince } from "./elapsed";

const NOW = Date.parse("2026-08-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("timeSince", () => {
  it("reads as 'just now' inside the first minute", () => {
    expect(timeSince(ago(0), NOW)).toBe("just now");
    expect(timeSince(ago(59_000), NOW)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(timeSince(ago(2 * 60_000), NOW)).toBe("2 min ago");
    expect(timeSince(ago(60 * 60_000), NOW)).toBe("1 hour ago");
    expect(timeSince(ago(5 * 3_600_000), NOW)).toBe("5 hours ago");
    expect(timeSince(ago(24 * 3_600_000), NOW)).toBe("yesterday");
    expect(timeSince(ago(3 * 86_400_000), NOW)).toBe("3 days ago");
  });

  it("falls back to the date after a week", () => {
    expect(timeSince(ago(9 * 86_400_000), NOW)).toContain("2026");
  });

  it("never counts forward from a clock skewed into the future", () => {
    expect(timeSince(ago(-60_000), NOW)).toBe("just now");
  });

  it("says nothing for an unparseable stamp", () => {
    expect(timeSince("not-a-date", NOW)).toBe("");
  });
});
