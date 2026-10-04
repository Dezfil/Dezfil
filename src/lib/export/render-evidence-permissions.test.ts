import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// The driver reads evidence the container wrote into a bind mount. On a Linux
// host those files keep the container user's ownership, and Chromium writes its
// net log owner-only, so the driver must open them up before its first read.
it("opens the container's evidence to the host before reading any of it", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/render-egress-driver.mjs"), "utf8");
  const opened = source.indexOf("'exec', '--user', '0:0', names[0], 'chmod', '-R', 'a+rwX', '/evidence'");
  const firstRead = source.indexOf("evidence[file] = readRows(await readFile(path.join(output");
  expect(opened, "permission step").toBeGreaterThan(-1);
  expect(firstRead, "first evidence read").toBeGreaterThan(-1);
  expect(opened).toBeLessThan(firstRead);
});
