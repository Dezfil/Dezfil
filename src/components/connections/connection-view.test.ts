import { describe, expect, it } from "vitest";
import { shortServerVersion } from "./connection-view";

describe("shortServerVersion", () => {
  it("keeps the product and version alone from a full version sentence", () => {
    expect(
      shortServerVersion(
        "PostgreSQL 18.6 (c5250a2) on aarch64-unknown-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit",
      ),
    ).toBe("PostgreSQL 18.6");
  });
  it("passes an already short value through", () => {
    expect(shortServerVersion("PostgreSQL 16.4")).toBe("PostgreSQL 16.4");
  });
  it("answers unknown for a connection never observed", () => {
    expect(shortServerVersion(null)).toBe("unknown");
  });
});
