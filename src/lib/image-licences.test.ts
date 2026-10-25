// Every package the image ships carries its licence: the build step copies
// each traced package's licence files back beside it, and the inventory check
// refuses an image where a package has none.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import { copyLicences, LICENCE_FILE, packageDirs } from "../../scripts/standalone-licences.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import { licencePresence, PUBLISHED_WITHOUT_LICENCE } from "../../scripts/check-image-inventory.mjs";

const scratch = mkdtempSync(join(tmpdir(), "dezfil-licences-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function plant(root: string, files: Record<string, string>) {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
  }
}

describe("the licence file names", () => {
  it.each(["LICENSE", "LICENSE.md", "license.txt", "LICENCE", "LICENSE-MIT", "LICENSE_APACHE", "COPYING", "NOTICE", "NOTICE.md"])("takes %s", (name) => {
    expect(LICENCE_FILE.test(name)).toBe(true);
  });
  it.each(["README.md", "licensee.js", "index.js", "package.json"])("leaves %s", (name) => {
    expect(LICENCE_FILE.test(name)).toBe(false);
  });
});

describe("copying licences into the standalone output", () => {
  const full = join(scratch, "full");
  const standalone = join(scratch, "standalone");
  plant(full, {
    "a/LICENSE": "MIT a", "a/index.js": "",
    "a/node_modules/c/licence.txt": "MIT c", "a/node_modules/c/y.js": "",
    "@s/b/LICENSE.md": "MIT b", "@s/b/NOTICE": "notice b", "@s/b/x.js": "",
    "d/z.js": "",
  });
  plant(standalone, {
    "a/index.js": "",
    "a/node_modules/c/y.js": "",
    "@s/b/x.js": "", "@s/b/LICENSE.md": "kept",
    "d/z.js": "",
    "e/only-here.js": "",
    ".bin/tool": "",
  });
  const result = copyLicences(full, standalone);

  it("finds every package, scoped and nested ones included, and skips dot folders", () => {
    expect(packageDirs(standalone)).toEqual(["@s/b", "a", "a/node_modules/c", "d", "e"]);
  });
  it("copies each package's licence files beside its traced code", () => {
    expect(readFileSync(join(standalone, "a/LICENSE"), "utf8")).toBe("MIT a");
    expect(readFileSync(join(standalone, "a/node_modules/c/licence.txt"), "utf8")).toBe("MIT c");
    expect(readFileSync(join(standalone, "@s/b/NOTICE"), "utf8")).toBe("notice b");
    expect(result).toMatchObject({ packages: 5, copied: 3 });
  });
  it("keeps a licence file the standalone copy already holds", () => {
    expect(readFileSync(join(standalone, "@s/b/LICENSE.md"), "utf8")).toBe("kept");
  });
  it("names the packages it could not give a licence file", () => {
    expect(result.withoutLicence).toEqual(["d", "e"]);
  });
});

describe("the inventory's licence rule", () => {
  const listing = [
    "d /app/node_modules/next",
    "f /app/node_modules/next/package.json",
    "f /app/node_modules/next/license.md",
    "f /app/node_modules/next/dist/esm/package.json",
    "f /app/node_modules/@img/colour/package.json",
    "f /app/node_modules/@img/colour/LICENSE.md",
    "f /app/node_modules/next/node_modules/semver/package.json",
    "f /app/node_modules/next/node_modules/semver/LICENSE",
    "f /app/package.json",
  ];
  it("passes when every package carries a licence file", () => {
    expect(licencePresence(listing)).toEqual([]);
  });
  it("names a package without one, top-level, scoped or nested", () => {
    for (const licence of ["f /app/node_modules/next/license.md", "f /app/node_modules/@img/colour/LICENSE.md", "f /app/node_modules/next/node_modules/semver/LICENSE"]) {
      const dir = licence.slice("f /app/node_modules/".length).replace(/\/[^/]+$/, "");
      expect(licencePresence(listing.filter((line) => line !== licence))).toEqual([`MISSING: a licence file in /app/node_modules/${dir}`]);
    }
  });
  it("does not take a package.json inside a package for another package", () => {
    expect(licencePresence(listing.filter((line) => line !== "f /app/node_modules/next/license.md"))).toHaveLength(1);
  });
  it("admits a package that publishes no licence file only when it is named, with its reason", () => {
    const [name, reason] = [...PUBLISHED_WITHOUT_LICENCE.entries()][0] ?? ["@example/none", undefined];
    expect(typeof reason).toBe("string");
    expect(licencePresence([`f /app/node_modules/${name}/package.json`])).toEqual([]);
    expect(licencePresence(["f /app/node_modules/unnamed-package/package.json"])).toEqual(["MISSING: a licence file in /app/node_modules/unnamed-package"]);
  });
});
