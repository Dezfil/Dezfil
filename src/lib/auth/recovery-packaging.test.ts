import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { judge, recoveryPresence, RECOVERY_REPO_PATHS } from "../../../scripts/check-image-inventory.mjs";

const runtime = ["scripts/admin-recover.mjs", "src/lib/auth/link-issuance.mjs", "src/lib/auth/recovery-store.mjs", "src/lib/auth/recovery.mjs"];
it("requires the complete standalone recovery closure and detects each missing artifact", () => {
  expect(RECOVERY_REPO_PATHS).toEqual(runtime);
  const listing = runtime.map(file => `f /app/${file}`);
  expect(recoveryPresence(listing)).toEqual([]);
  for (const missing of listing) expect(recoveryPresence(listing.filter(file => file !== missing)))
    .toEqual([`MISSING: ${missing.slice(2)}`]);
  const declaration = "src/lib/auth/link-issuance.d.mts";
  expect(judge([...listing, `f /app/${declaration}`], new Set([...runtime, declaration]))).toEqual([]);
  expect(judge([`f /app/${declaration}`], new Set())).toContain(`file the repository does not track: /app/${declaration}`);
});
it("keeps the runtime import closure to copied ESM, Node built-ins and the existing SQLite dependency", () => {
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
  for (const file of runtime) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) expect(runtime).toContain(path.posix.join(path.posix.dirname(file), specifier));
      else expect(specifier === "better-sqlite3" || builtins.has(specifier.replace(/^node:/, ""))).toBe(true);
    }
  }
});
it("copies the recovery entry and runtime modules explicitly into the runner", () => {
  const docker = readFileSync("Dockerfile", "utf8").split("AS runner")[1];
  for (const file of runtime) expect(docker).toContain(`/app/${file} ./${file}`);
  // The SQLite driver loads its prebuilt binary itself; its one declared
  // dependency, node-addon-api, is headers for compiling and never loaded.
  expect(docker).toContain("/app/node_modules/better-sqlite3 ./node_modules/better-sqlite3");
});
it("invokes the checkout entry through the package script with native Node ESM", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.scripts["admin:recover"]).toBe("node scripts/admin-recover.mjs");
  const result = spawnSync("npm", ["run", "--silent", "admin:recover", "--", "--help"], { encoding: "utf8", env: process.env });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("--data-dir DIRECTORY --origin HTTP_OR_HTTPS_ORIGIN");
  expect(result.stdout).not.toContain("dz_link_");
});
