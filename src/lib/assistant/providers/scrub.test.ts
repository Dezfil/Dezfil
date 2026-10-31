import { inspect } from "node:util";
import { expect, it } from "vitest";
import { scrubbedError, scrubKey } from "./scrub";

const KEY = "sk-canary/with+reserved=characters-0000";

it("takes the key out of text, plain and as a URL carries it", () => {
  expect(scrubKey(`refused ${KEY} and ${KEY}`, KEY)).toBe("refused [key removed] and [key removed]");
  expect(scrubKey(`refused ${encodeURIComponent(KEY)}`, KEY)).toBe("refused [key removed]");
  expect(scrubKey("nothing to take", KEY)).toBe("nothing to take");
});

it("hands back the same failure when nothing it would print holds the key", () => {
  const error = new TypeError("fetch failed");
  expect(scrubbedError(error, KEY)).toBe(error);
});

it.each([
  ["its message", () => new TypeError(`fetch failed for ${KEY}`)],
  ["its cause", () => Object.assign(new TypeError("fetch failed"), { cause: new Error(`socket ${KEY}`) })],
  ["a field", () => Object.assign(new Error("failed"), { request: { headers: { "x-api-key": KEY } } })],
  ["something thrown that is no error", () => `plain ${KEY}`],
])("leaves nothing printable when %s holds the key", (_label, make) => {
  const cleaned = scrubbedError(make(), KEY);
  expect(inspect(cleaned, { depth: 8 })).not.toContain(KEY);
  expect(cleaned).toBeInstanceOf(Error);
});
