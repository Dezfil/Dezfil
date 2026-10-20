import { expect, it } from "vitest";
import { allowedErrorPatterns, isAllowedConsoleError } from "../../../e2e/console-allowlist";

/**
 * Nothing in the browser uploads card pictures any more, so the browser
 * suites excuse no refused upload: a 410 from the retired upload address
 * is an error like any other, and the allowance list holds no entry.
 */

const gone = "Failed to load resource: the server responded with a status of 410 (Gone)";
const upload = "http://127.0.0.1:3581/api/maps/0748f6f3-df4a-4c71-9971-4d975b0c48f2/thumbnail?theme=light&cycle=mvfn3qiq-v4cxjl40&revision=172ad0add173856c";

it("excuses no refused picture upload, in either theme", () => {
  expect(allowedErrorPatterns).toEqual([]);
  for (const theme of ["light", "dark"]) expect(isAllowedConsoleError(gone, upload.replace("theme=light", `theme=${theme}`))).toBe(false);
});

it("keeps other statuses, requests and console messages actionable", () => {
  for (const url of [
    upload.split("?")[0],
    upload.replace(/&cycle=[^&]+/, ""),
    upload.replace("thumbnail?", "picture/refresh?"),
    upload.replace("/api/maps/", "/api/projects/"),
  ]) expect(isAllowedConsoleError(gone, url), url).toBe(false);
  expect(isAllowedConsoleError(gone)).toBe(false);
  expect(isAllowedConsoleError(gone.replace("410 (Gone)", "500 (Internal Server Error)"), upload)).toBe(false);
  expect(isAllowedConsoleError("Application error: 410 (Gone)", upload)).toBe(false);
});
