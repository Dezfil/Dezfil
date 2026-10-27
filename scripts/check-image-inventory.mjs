// The runtime image contains what we say and nothing else. The check enumerates /app inside the built image and fails
// when a top-level entry falls outside the checked-in allowlist, when a
// file under a mirrored source tree carries a class the tree never
// legitimately holds (a nested planted file must not hide inside an
// allowed directory), or when forbidden material —
// repository metadata, the live data directory, database or key
// material, environment files, specs — appears anywhere in the tree.
// Scope: /app is the composed artifact; tippecanoe lands in
// /usr/local/bin by the Dockerfile and the OS base is the base image's.
//
// Usage:
//   node scripts/check-image-inventory.mjs [image-tag]     # default dezfil:ci
//   node scripts/check-image-inventory.mjs --listing FILE [--arch x64|arm64]
//     # judge a saved listing (lines are "f /app/…" for files, "d /app/…"
//     # for directories), for an image of that architecture (x64 by default)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LICENCE_FILE } from "./standalone-licences.mjs";

export const MODEL_CATALOGUE_REPO_PATH = "src/lib/assistant/model-catalogue.json";
export const MODEL_CATALOGUE_IMAGE_PATH = `/app/${MODEL_CATALOGUE_REPO_PATH}`;

/** An allowlisted JSON file must actually be present in the artifact. */
export function cataloguePresence(lines) {
  return lines.some((line) => line.trim() === `f ${MODEL_CATALOGUE_IMAGE_PATH}`)
    ? [] : [`MISSING: ${MODEL_CATALOGUE_IMAGE_PATH}`];
}

/** The shipped templates' index must actually be present: without it the
 * image would ship no template and say nothing. */
export const SHIPPED_TEMPLATES_INDEX_IMAGE_PATH = "/app/templates/index.json";
export function templatesPresence(lines) {
  return lines.some((line) => line.trim() === `f ${SHIPPED_TEMPLATES_INDEX_IMAGE_PATH}`)
    ? [] : [`MISSING: ${SHIPPED_TEMPLATES_INDEX_IMAGE_PATH}`];
}

export const MVT_WORKER_REPO_PATH =
  "public/workers/loaders.gl-mvt-worker-4.5.4.js";
export const INGRESS_REPO_PATHS = [
  "scripts/ingress-preload.mjs", "scripts/preload-options.mjs", "src/lib/auth/ingress.mjs", "src/lib/auth/reception.mjs",
];
export function ingressPresence(lines) {
  const present = new Set(lines.map(line => line.trim()));
  return INGRESS_REPO_PATHS.filter(file => !present.has(`f /app/${file}`)).map(file => `MISSING: /app/${file}`);
}
export const RECOVERY_REPO_PATHS = [
  "scripts/admin-recover.mjs", "src/lib/auth/link-issuance.mjs", "src/lib/auth/recovery-store.mjs", "src/lib/auth/recovery.mjs",
];
export function recoveryPresence(lines) {
  const present = new Set(lines.map(line => line.trim()));
  return RECOVERY_REPO_PATHS.filter(file => !present.has(`f /app/${file}`)).map(file => `MISSING: /app/${file}`);
}
/** The picture library ships for the image's own architecture: npm ci
 * installs the build platform's binary and libvips, so an arm64 build
 * carries arm64 packages and an x64 build x64 ones. The packages its
 * JavaScript requires ship beside it. */
export function imageArchitecture(dockerArchitecture) {
  const arch = { amd64: "x64", arm64: "arm64" }[dockerArchitecture];
  if (!arch) throw new Error(`Unsupported image architecture: ${dockerArchitecture}`);
  return arch;
}
export function picturePresence(lines, arch) {
  const files = lines.map(line => line.trim()).filter(line => line.startsWith("f ")).map(line => line.slice(2));
  const required = [
    { file: "/app/node_modules/sharp/package.json", what: "the picture library" },
    { file: "/app/node_modules/detect-libc/package.json", what: "a package the picture library requires" },
    { file: "/app/node_modules/semver/package.json", what: "a package the picture library requires" },
    { file: "/app/node_modules/@img/colour/package.json", what: "a package the picture library requires" },
    { pattern: new RegExp(`^/app/node_modules/@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-[0-9.]+\\.node$`),
      file: `/app/node_modules/@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-<version>.node`, what: `the picture library's ${arch} binary` },
    { pattern: new RegExp(`^/app/node_modules/@img/sharp-libvips-linux-${arch}/lib/libvips-cpp\\.so\\.[0-9.]+$`),
      file: `/app/node_modules/@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.<version>`, what: `libvips for ${arch}` },
  ];
  return required.filter(({ file, pattern }) => !files.some(present => pattern ? pattern.test(present) : present === file))
    .map(({ file, what }) => `MISSING: ${file} — ${what}`);
}
/** The metadata store's engine publishes a prebuilt binary for every
 * platform it supports; the build keeps only the one the package picks on
 * the image's own platform, so the image ships that binary and no other. */
export function sqlitePresence(lines, arch) {
  const files = lines.map(line => line.trim()).filter(line => line.startsWith("f ")).map(line => line.slice(2));
  const binary = `/app/node_modules/better-sqlite3/prebuilds/linux-${arch}.node`;
  const missing = files.includes(binary) ? [] : [`MISSING: ${binary} — the metadata store's ${arch} binary`];
  const foreign = files.filter(file => /^\/app\/node_modules\/better-sqlite3\/prebuilds\/[^/]+\.node$/.test(file) && file !== binary)
    .map(file => `a binary for another platform: ${file}`);
  return [...missing, ...foreign];
}
/** Packages that publish no licence file of their own, by name, with what
 * their package.json declares and where the image holds the licence's text
 * (NOTICE says the same). Any other package without one fails. */
const LIBVIPS_LICENCE = "LGPL-3.0-or-later: its README.md lists each bundled library's licence, and the base image keeps the LGPL and GPL texts in /usr/share/common-licenses";
const APACHE_LICENCE = "Apache-2.0: the licence text is /app/LICENSE";
export const PUBLISHED_WITHOUT_LICENCE = new Map([
  ["@img/sharp-libvips-linux-arm64", LIBVIPS_LICENCE],
  ["@img/sharp-libvips-linux-x64", LIBVIPS_LICENCE],
  ["@next/env", "MIT: published from the Next.js repository, whose licence is next/license.md"],
  ["@puppeteer/browsers", APACHE_LICENCE],
  ["client-only", "MIT: publishes two code files and no licence text or copyright line"],
  ["puppeteer-core", APACHE_LICENCE],
]);

/** True when `parts`, a folder's path below /app/node_modules, is a package's
 * root: a name or @scope/name, possibly under another package's node_modules. */
function isPackageRoot(parts) {
  let i = 0;
  while (i < parts.length) {
    i += parts[i].startsWith("@") ? 2 : 1;
    if (i === parts.length) return true;
    if (i > parts.length || parts[i] !== "node_modules") return false;
    i += 1;
  }
  return false;
}

/** Every package the image ships carries a licence file at its root, as its
 * licence asks of every copy (the build copies them back after the
 * standalone trace). */
export function licencePresence(lines) {
  const roots = new Set();
  const licensed = new Set();
  for (const line of lines) {
    const entry = line.trim();
    if (!entry.startsWith("f /app/node_modules/")) continue;
    const parts = entry.slice("f /app/node_modules/".length).split("/");
    const name = parts.pop();
    if (!isPackageRoot(parts)) continue;
    if (name === "package.json") roots.add(parts.join("/"));
    if (LICENCE_FILE.test(name)) licensed.add(parts.join("/"));
  }
  return [...roots].sort()
    .filter((dir) => !licensed.has(dir) && !PUBLISHED_WITHOUT_LICENCE.has(dir.replace(/^.*\/node_modules\//, "")))
    .map((dir) => `MISSING: a licence file in /app/node_modules/${dir}`);
}
export const MVT_WORKER_IMAGE_PATH = `/app/${MVT_WORKER_REPO_PATH}`;
export const BROWSER_WORKER_REPO_PATHS = [
  MVT_WORKER_REPO_PATH,
  "public/workers/maplibre-gl-6.14.0/maplibre-gl-worker.mjs",
  "public/workers/maplibre-gl-6.14.0/maplibre-gl-shared.mjs",
];

/** Every path the image may carry at the top of /app. The standalone
 * tracer mirrors the (dockerignore-filtered) build context, so the build
 * inputs appear alongside the composed runtime pieces. Anything new must
 * be added here deliberately — that is the point. */
export const TOP_LEVEL_ALLOWLIST = new Set([
  // Composed runtime pieces (Dockerfile runner stage).
  "server.js",
  ".next",
  "node_modules",
  "duckdb-extensions",
  "package.json",
  // Licensing travels with the artifact (Apache-2.0 + NOTICE).
  "LICENSE",
  "NOTICE",
  // Build inputs the standalone tracer mirrors from the filtered context.
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.mjs",
  "playwright.config.ts",
  "vitest.config.ts",
  ".gitignore",
  // Repository settings the tracer mirrors too: line endings and the Node version.
  ".gitattributes",
  ".nvmrc",
  "public",
  "scripts",
  "src",
  // The shipped templates: installed version folders and their index.
  "templates",
]);

/** The mirrored source trees are wholly ours, so they are held to an
 * exact manifest: every file under them must be a
 * path git tracks at the built commit — a planted
 * `src/private-config.json` fails even with a legitimate-looking
 * extension. The extension rule below stays as defense in depth, and
 * `.next` / `node_modules` stay class-guarded: their contents are
 * build- and dependency-generated, so an exact manifest of them would
 * be flaky by construction, while planting into them requires changing
 * the build itself — the same trust boundary as the Dockerfile. */
const SOURCE_TREE_EXTENSIONS = new Set([
  "ts",
  "mts",
  "tsx",
  "css",
  "svg",
  "mjs",
  "json",
  // WebP is admitted for the basemap thumbnails: the
  // basemap picker names each style with a capture of that style, which
  // no vector format can stand in for. Admitting the class deliberately
  // is what this check is for — the manifest rule above still holds, so
  // every such file must be one git tracks at the built commit.
  "webp",
]);
// Application-owned browser workers are executable public assets. Admit the
// class only where it is needed; the exact tracked-file manifest still
// prevents arbitrary scripts from being planted there.
const TREE_EXTENSION_ADDITIONS = new Map([
  ["public", new Set(["js"])],
]);
// A tree held to classes of its own instead of the source trees': the
// shipped templates hold documents, datasets and pictures, and nothing a
// source tree holds (no code, no stylesheet, no vector image).
const TREE_EXTENSIONS_ONLY = new Map([
  ["templates", new Set(["json", "parquet", "png"])],
]);
const EXTENSION_CONSTRAINED = new Set(["src", "scripts", "public", "templates"]);
const MANIFEST_TREES = EXTENSION_CONSTRAINED;

/** Material that must never appear anywhere in the shipped tree.
 * node_modules is exempt from the generic file-class rules — dependency
 * packages ship sample .env files, test certificates and sqlite
 * fixtures — but never from the repository/data/named-secret rules. */
export const FORBIDDEN = [
  {
    reason: "git metadata",
    test: (p) => /(^|\/)\.git(\/|$)/.test(p),
  },
  {
    reason: "live data directory",
    test: (p) => /^data(\/|$)/.test(p),
  },
  {
    reason: "secret key material",
    test: (p) => /(^|\/)secret\.key$/.test(p),
  },
  {
    reason: "metadata database",
    test: (p) => /(^|\/)metadata\.sqlite$/.test(p),
  },
  {
    reason: "key or certificate material outside node_modules",
    test: (p) =>
      !p.startsWith("node_modules/") &&
      (/\.(pem|key|p12|pfx|crt|der)$/.test(p) ||
        /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/.test(p)),
  },
  {
    reason: "database or dump file outside node_modules",
    test: (p) =>
      !p.startsWith("node_modules/") &&
      /\.(sql|sqlite|sqlite3|db|dump)$/.test(p),
  },
  {
    reason: "credentials file outside node_modules",
    test: (p) =>
      !p.startsWith("node_modules/") && /(^|\/)\.(npmrc|netrc)$/.test(p),
  },
  {
    reason: "environment file outside node_modules",
    test: (p) =>
      !p.startsWith("node_modules/") && /(^|\/)\.env(\..+)?$/.test(p),
  },
  {
    reason: "docs / specs",
    test: (p) => /^(docs|sdd)(\/|$)/.test(p),
  },
  {
    reason: "git worktrees",
    test: (p) => /^\.worktrees(\/|$)/.test(p),
  },
];

/** Judge a tagged listing ("f /app/…" files and symlinks, "d /app/…"
 * directories) against the rules and, for the mirrored source trees,
 * against the exact set of git-tracked paths. Pure — the red-proof unit
 * test drives it on planted fixtures. Returns human-readable
 * violations. */
export function judge(lines, trackedFiles) {
  const violations = [];
  for (const raw of lines) {
    const m = /^([df])\s+(.*)$/.exec(raw.trim());
    if (!m) continue;
    const kind = m[1];
    const p = m[2].replace(/^\/app\/?/, "").trim();
    if (!p) continue;
    const segments = p.split("/");
    const top = segments[0];
    if (!TOP_LEVEL_ALLOWLIST.has(top)) {
      violations.push(`unexpected top-level entry: ${top} (from ${m[2]})`);
    }
    if (kind === "f" && segments.length > 1) {
      const name = segments[segments.length - 1];
      const ext = name.includes(".") ? name.split(".").pop() : null;
      if (MANIFEST_TREES.has(top) && trackedFiles && !trackedFiles.has(p)) {
        violations.push(`file the repository does not track: ${m[2]}`);
      }
      const only = TREE_EXTENSIONS_ONLY.get(top);
      if (
        EXTENSION_CONSTRAINED.has(top) &&
        (!ext ||
          (only
            ? !only.has(ext.toLowerCase())
            : !SOURCE_TREE_EXTENSIONS.has(ext.toLowerCase()) &&
              !TREE_EXTENSION_ADDITIONS.get(top)?.has(ext.toLowerCase())))
      ) {
        violations.push(`file class the ${top}/ tree never holds: ${m[2]}`);
      }
      if (
        top === "duckdb-extensions" &&
        !/\.duckdb_extension(\.info)?$/.test(name)
      ) {
        violations.push(
          `file class the extension bundle never holds: ${m[2]}`,
        );
      }
    }
    for (const rule of FORBIDDEN) {
      if (rule.test(p)) violations.push(`${rule.reason}: ${m[2]}`);
    }
  }
  // One line per offender, deduplicated (directories list every child).
  return [...new Set(violations)];
}

/** The exact-path manifest for the mirrored source trees: what git
 * tracks at the checked-out commit. Requires running inside the repo
 * checkout — which is exactly where the image job runs. */
export function trackedManifest(cwd = process.cwd()) {
  const out = execFileSync(
    "git",
    ["ls-files", "--", ...MANIFEST_TREES],
    { encoding: "utf8", cwd, maxBuffer: 64 * 1024 * 1024 },
  );
  return new Set(out.split("\n").filter(Boolean));
}

function listingFromImage(image) {
  // Tag directories "d" and everything else (files, symlinks) "f", so
  // the judge can hold source trees to their file classes.
  const out = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      image,
      "sh",
      "-c",
      'find /app -mindepth 1 -type d | sed "s/^/d /"; find /app -mindepth 1 ! -type d | sed "s/^/f /"',
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  return out.split("\n");
}

const isMain = process.argv[1]?.endsWith("check-image-inventory.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const listing =
    args[0] === "--listing"
      ? readFileSync(args[1], "utf8").split("\n")
      : listingFromImage(args[0] ?? "dezfil:ci");
  // A saved listing names its architecture with --arch (x64 unless named).
  const arch = args[0] === "--listing"
    ? (args.includes("--arch") ? args[args.indexOf("--arch") + 1] : "x64")
    : imageArchitecture(execFileSync("docker", ["image", "inspect", "--format", "{{.Architecture}}", args[0] ?? "dezfil:ci"], { encoding: "utf8" }).trim());
  const violations = [...judge(listing, trackedManifest()), ...cataloguePresence(listing), ...ingressPresence(listing), ...recoveryPresence(listing), ...templatesPresence(listing), ...picturePresence(listing, arch), ...sqlitePresence(listing, arch), ...licencePresence(listing)];
  // Positive presence proofs: the browser and trust store required by image
  // export, plus the application-owned parser worker required by
  // every tiled map host. An allowlist only says a path MAY ship;
  // these assertions say the required runtime pieces DO ship.
  if (args[0] !== "--listing") {
    const present = new Set();
    for (const [path, what] of [
      ["/usr/bin/chromium", "the image-export browser (DEZFIL_CHROMIUM_PATH default)"],
      ["/etc/ssl/certs/ca-certificates.crt", "the CA trust store for HTTPS basemaps"],
      ...BROWSER_WORKER_REPO_PATHS.map(path => [`/app/${path}`, "an application-owned renderer worker artifact"]),
    ]) {
      try {
        execFileSync("docker", [
          "run", "--rm", args[0] ?? "dezfil:ci", "test", "-e", path,
        ]);
        present.add(path);
      } catch {
        violations.push(`MISSING: ${path} — ${what}`);
      }
    }

    // Presence is not enough for a copied upstream executable: prove the
    // bytes inside the exact image match the checked-in, version-parity-tested
    // worker. A stale Docker layer or wrong COPY target is therefore red.
    for (const repoPath of BROWSER_WORKER_REPO_PATHS) {
      const imagePath = `/app/${repoPath}`;
      if (!present.has(imagePath)) continue;
      try {
        const expected = createHash("sha256")
          .update(readFileSync(repoPath))
          .digest("hex");
        const actual = execFileSync(
          "docker",
          [
            "run",
            "--rm",
            args[0] ?? "dezfil:ci",
            "sha256sum",
            imagePath,
          ],
          { encoding: "utf8" },
        ).split(/\s+/)[0];
        if (actual !== expected) {
          violations.push(
            `MISMATCH: ${imagePath} — image bytes differ from the tracked worker`,
          );
        }
      } catch {
        violations.push(
          `UNREADABLE: ${imagePath} — could not prove worker bytes`,
        );
      }
    }
  }
  if (violations.length > 0) {
    for (const v of violations.slice(0, 50)) console.error(v);
    if (violations.length > 50) {
      console.error(`… and ${violations.length - 50} more`);
    }
    console.error(`FAIL — ${violations.length} inventory violation(s).`);
    process.exit(1);
  }
  console.log(
    `PASS — ${listing.filter((l) => l.trim()).length} paths, all within the allowlist.`,
  );
}
