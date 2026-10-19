import { expect, it } from "vitest";
import { isAllowedConsoleError } from "../../../e2e/console-allowlist";

const gone = "Failed to load resource: the server responded with a status of 410 (Gone)";
const upload = "http://127.0.0.1:3581/api/maps/0748f6f3-df4a-4c71-9971-4d975b0c48f2/thumbnail?theme=light&cycle=mvfn3qiq-v4cxjl40&revision=172ad0add173856c";

it.each(["light", "dark"])("allows the retired %s capture upload's resource error", theme => {
  expect(isAllowedConsoleError(gone, upload.replace("theme=light", `theme=${theme}`))).toBe(true);
});

it("keeps other statuses, requests and console messages actionable", () => {
  for (const url of [
    upload.split("?")[0],
    upload.replace(/&cycle=[^&]+/, ""),
    upload.replace(/&revision=[^&]+/, ""),
    upload.replace("thumbnail?", "picture/refresh?"),
    upload.replace("/api/maps/", "/api/projects/"),
    upload.replace("theme=light", "theme=auto"),
    `${upload}&extra=1`,
  ]) expect(isAllowedConsoleError(gone, url), url).toBe(false);
  expect(isAllowedConsoleError(gone)).toBe(false);
  expect(isAllowedConsoleError(gone.replace("410 (Gone)", "500 (Internal Server Error)"), upload)).toBe(false);
  expect(isAllowedConsoleError("Application error: 410 (Gone)", upload)).toBe(false);
});
