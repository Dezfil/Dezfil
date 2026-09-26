import { describe, it, expect } from "vitest";
import { FINE_POINTER_QUERY, hasFinePointer } from "./pointer";

describe("pointer capability guard", () => {
  it("asks for a fine pointer, not the primary one — hybrids keep their cursor", () => {
    expect(FINE_POINTER_QUERY).toBe("(any-pointer: fine)");
  });

  it("shows the readout only when the media query matches", () => {
    const queries: string[] = [];
    const media = (query: string) => {
      queries.push(query);
      return { matches: query === FINE_POINTER_QUERY };
    };
    expect(hasFinePointer(media)).toBe(true);
    expect(queries).toEqual([FINE_POINTER_QUERY]);
    expect(hasFinePointer(() => ({ matches: false }))).toBe(false);
  });
});
