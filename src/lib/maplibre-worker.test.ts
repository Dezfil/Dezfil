import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { getWorkerUrl } from "./maplibre";
import { BROWSER_WORKER_REPO_PATHS } from "../../scripts/check-image-inventory.mjs";

it("serves the exact installed ESM worker and its shared chunk from the configured local path", () => {
  const packageDir = dirname(require.resolve("maplibre-gl/package.json"));
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const workerPath = `/workers/maplibre-gl-${version}/maplibre-gl-worker.mjs`;
  expect(getWorkerUrl()).toBe(workerPath);
  for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
    expect(BROWSER_WORKER_REPO_PATHS).toContain(`public${dirname(workerPath)}/${file}`);
    const served = readFileSync(join(process.cwd(), "public", dirname(workerPath), file));
    expect(served.equals(readFileSync(join(packageDir, "dist", file))), file).toBe(true);
  }
  expect(readFileSync(join(process.cwd(), "NOTICE"), "utf8"))
    .toContain(readFileSync(join(packageDir, "LICENSE.txt"), "utf8").trim());
});
