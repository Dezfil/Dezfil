// Next's standalone output copies the files a package's code needs, not the
// package's licence, while MIT and most other licences ask for their notice in
// every copy. The image build runs this after `next build` to put each traced
// package's licence files back beside it, copied from the full install.
//
// Usage: node scripts/standalone-licences.mjs <full node_modules> <standalone node_modules>
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** A package's licence or notice file at its root: LICENSE, LICENSE.md,
 * LICENCE-MIT, license.txt, COPYING, NOTICE and the like. */
export const LICENCE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;

/** Every package folder under a node_modules folder, scoped and nested ones
 * included, as paths relative to it ("next", "@img/colour",
 * "next/node_modules/semver"). */
export function packageDirs(root, prefix = "") {
  const found = [];
  if (!existsSync(root)) return found;
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const names = name.startsWith("@")
      ? readdirSync(path.join(root, name)).sort().map((child) => `${name}/${child}`)
      : [name];
    for (const pkg of names) {
      const dir = path.join(root, pkg);
      if (!statSync(dir).isDirectory()) continue;
      found.push(prefix + pkg);
      found.push(...packageDirs(path.join(dir, "node_modules"), `${prefix}${pkg}/node_modules/`));
    }
  }
  return found;
}

/** The licence files at a package folder's root. */
export function licenceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => LICENCE_FILE.test(name) && statSync(path.join(dir, name)).isFile()).sort();
}

/** Copy each package's licence files from the full install into the
 * standalone copy, keeping any the copy already holds. Returns what it did
 * and the packages it could not give a licence file. */
export function copyLicences(from, to) {
  const result = { packages: 0, copied: 0, withoutLicence: [] };
  for (const pkg of packageDirs(to)) {
    result.packages += 1;
    const source = licenceFiles(path.join(from, pkg));
    for (const name of source) {
      const target = path.join(to, pkg, name);
      if (existsSync(target)) continue;
      copyFileSync(path.join(from, pkg, name), target);
      result.copied += 1;
    }
    if (licenceFiles(path.join(to, pkg)).length === 0) result.withoutLicence.push(pkg);
  }
  return result;
}

if (process.argv[1]?.endsWith("standalone-licences.mjs")) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error("Usage: node scripts/standalone-licences.mjs <full node_modules> <standalone node_modules>");
    process.exit(2);
  }
  const { packages, copied, withoutLicence } = copyLicences(from, to);
  console.log(`Licence files: ${copied} copied into ${packages} packages.`);
  if (withoutLicence.length) console.log(`Published without a licence file: ${withoutLicence.join(", ")}`);
}
