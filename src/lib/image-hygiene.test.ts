// The release-hygiene checks must be demonstrably red against a
// violating artifact — a check that cannot be shown red is not evidence.
// The inventory judge runs on planted listings; the offline extension
// check runs against an empty bundle. CI runs both against the real
// built image in the image job.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import dockerIgnore from "@balena/dockerignore";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import {
  judge,
  cataloguePresence,
  imageArchitecture,
  ingressPresence,
  INGRESS_REPO_PATHS,
  picturePresence,
  MODEL_CATALOGUE_REPO_PATH,
  MODEL_CATALOGUE_IMAGE_PATH,
  MVT_WORKER_IMAGE_PATH,
  MVT_WORKER_REPO_PATH,
  SHIPPED_TEMPLATES_INDEX_IMAGE_PATH,
  sqlitePresence,
  TOP_LEVEL_ALLOWLIST,
  templatesPresence,
  trackedManifest,
} from "../../scripts/check-image-inventory.mjs";

it("requires every ingress preload file in the shipped image", () => {
  const complete = INGRESS_REPO_PATHS.map(file => `f /app/${file}`);
  expect(ingressPresence(complete)).toEqual([]);
  for (const missing of complete) {
    expect(ingressPresence(complete.filter(line => line !== missing))).toEqual([`MISSING: ${missing.slice(2)}`]);
  }
});

describe("the picture library in the shipped image", () => {
  const listing = (arch: string) => [
    "f /app/node_modules/sharp/package.json",
    "f /app/node_modules/sharp/dist/index.cjs",
    "f /app/node_modules/detect-libc/package.json",
    "f /app/node_modules/semver/package.json",
    "f /app/node_modules/@img/colour/package.json",
    `f /app/node_modules/@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-0.35.5.node`,
    `f /app/node_modules/@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.8.18.7`,
  ];
  it.each(["x64", "arm64"])("passes a complete %s listing", (arch) => {
    expect(picturePresence(listing(arch), arch)).toEqual([]);
  });
  it("names each missing package, one at a time", () => {
    const complete = listing("x64");
    for (const line of complete.filter((entry) => !entry.includes("/dist/"))) {
      const problems = picturePresence(complete.filter((entry) => entry !== line), "x64");
      expect(problems, line).toHaveLength(1);
      expect(problems[0]).toMatch(/^MISSING: /);
    }
  });
  it("judges the image's own architecture: an arm64 build's packages are missing from an x64 image", () => {
    expect(picturePresence(listing("arm64"), "x64")).toEqual([
      "MISSING: /app/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-<version>.node — the picture library's x64 binary",
      "MISSING: /app/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.<version> — libvips for x64",
    ]);
  });
  it("reads the architecture Docker reports, and refuses one it does not ship", () => {
    expect([imageArchitecture("amd64"), imageArchitecture("arm64")]).toEqual(["x64", "arm64"]);
    expect(() => imageArchitecture("s390x")).toThrow("Unsupported image architecture: s390x");
  });
});

describe("the metadata store's engine in the shipped image", () => {
  const listing = (arch: string) => [
    "f /app/node_modules/better-sqlite3/package.json",
    "f /app/node_modules/better-sqlite3/lib/index.js",
    `f /app/node_modules/better-sqlite3/prebuilds/linux-${arch}.node`,
  ];
  it.each(["x64", "arm64"])("passes a %s listing with that platform's binary alone", (arch) => {
    expect(sqlitePresence(listing(arch), arch)).toEqual([]);
  });
  it("names the binary when the image lacks it", () => {
    expect(sqlitePresence(listing("x64").slice(0, 2), "x64")).toEqual([
      "MISSING: /app/node_modules/better-sqlite3/prebuilds/linux-x64.node — the metadata store's x64 binary",
    ]);
  });
  it("judges the image's own architecture: an arm64 binary in an x64 image is both missing and foreign", () => {
    expect(sqlitePresence(listing("arm64"), "x64")).toEqual([
      "MISSING: /app/node_modules/better-sqlite3/prebuilds/linux-x64.node — the metadata store's x64 binary",
      "a binary for another platform: /app/node_modules/better-sqlite3/prebuilds/linux-arm64.node",
    ]);
  });
  it("names every other platform's binary the package publishes", () => {
    const others = ["darwin-arm64", "linuxmusl-x64", "win32-x64"].map(
      (target) => `f /app/node_modules/better-sqlite3/prebuilds/${target}.node`,
    );
    expect(sqlitePresence([...listing("x64"), ...others], "x64")).toEqual(
      others.map((line) => `a binary for another platform: ${line.slice(2)}`),
    );
  });
});

function unexpectedContextEntries(trackedFiles: string[], ignoreFile: string) {
  const ignored = dockerIgnore({ ignorecase: false }).add(ignoreFile);
  const paths = new Set<string>();
  for (const file of trackedFiles) {
    const parts = file.split("/");
    // Include directories even when all their files are ignored: empty
    // directories can still be traced. Inspect descendants too, since a
    // Docker negation can re-include a file beneath an excluded parent.
    for (let depth = 1; depth <= parts.length; depth++) {
      paths.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...new Set([...paths]
    .filter((path) => !TOP_LEVEL_ALLOWLIST.has(path.split("/")[0]) && !ignored.ignores(path))
    .map((path) => path.split("/")[0]))].sort();
}

describe("tracked build context coverage", () => {
  it("every tracked top-level entry is runtime-allowlisted or Docker-ignored", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    const unexpected = unexpectedContextEntries(
      tracked,
      readFileSync(join(root, ".dockerignore"), "utf8"),
    );
    expect(unexpected, `Tracked entries neither runtime-allowlisted nor Docker-ignored: ${unexpected.join(", ")}`).toEqual([]);
  });

  it.each([
    { name: "root globs and comments", files: ["README.md", "package.json"], rules: "# documentation\n\n*.md\n", expected: [] },
    { name: "leading and trailing slashes", files: ["notes/nested/draft.md"], rules: " /notes/ \n", expected: [] },
    { name: "empty parent directories", files: ["notes/draft.md"], rules: "notes/*.md\n", expected: ["notes"] },
    { name: "last matching negation", files: ["README.md"], rules: "*.md\n!README.md\n", expected: ["README.md"] },
    { name: "last matching exclusion", files: ["README.md"], rules: "*.md\n!README.md\nREADME*\n", expected: [] },
    { name: "re-included descendants of ignored parents", files: ["notes/deep/keep.md"], rules: "notes\n!notes/**/keep.md\n", expected: ["notes"] },
    { name: "case-sensitive Docker matching", files: ["Notes/draft.md"], rules: "notes\n", expected: ["Notes"] },
  ])("honors $name", ({ files, rules, expected }) => {
    expect(unexpectedContextEntries(files, rules)).toEqual(expected);
  });
});

// The image job runs on main only, so a fixture class that the inventory rejects surfaces one merge
// late — five did on, added while CI was off. This holds the same rule where the PR checks run: the
// tracked files of the mirrored trees, filtered as Docker filters the context, carry no class the
// judge rejects. It goes red when a rejected class enters the trees without a matching.dockerignore
// rule.
describe("filtered build context passes the inventory", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const rules = readFileSync(join(root, ".dockerignore"), "utf8");
  const ignored = dockerIgnore({ ignorecase: false }).add(rules);

  it("the tracked mirrored trees, Docker-filtered, hold no rejected class", () => {
    const tracked = [...trackedManifest(root)];
    expect(tracked.length).toBeGreaterThan(0);
    const listing = tracked.filter((f) => !ignored.ignores(f)).map((f) => `f /app/${f}`);
    expect(listing.length).toBeGreaterThan(0);
    expect(judge(listing, new Set(tracked))).toEqual([]);
  });

  it.each([
    "src/lib/x/__snapshots__/y.test.ts.snap",
    "src/lib/x/fixtures/rows.csv",
    "src/lib/x/fixtures/prompt.txt",
    "scripts/probe-client.Dockerfile",
  ])("%s: the judge rejects the class and the ignore file excludes the path", (path) => {
    const violations = judge([`f /app/${path}`], new Set([path]));
    expect(violations.some((v) => v.includes("never holds"))).toBe(true);
    expect(ignored.ignores(path)).toBe(true);
  });

  it("a fixture-shaped path outside the ignored shapes stays in the context", () => {
    expect(ignored.ignores("scripts/mcp-journey-fixtures.mjs")).toBe(false);
    expect(ignored.ignores("src/lib/assistant/model-catalogue.json")).toBe(false);
  });
});

const CLEAN: string[] = [
  "f /app/server.js",
  "f /app/package.json",
  "f /app/tsconfig.build.json",
  "d /app/.next",
  "f /app/.next/server/app/api/health/route.js",
  "d /app/node_modules",
  "f /app/node_modules/next/package.json",
  "f /app/node_modules/somepkg/.env.example",
  "f /app/node_modules/somepkg/fixtures/test.sqlite",
  "f /app/node_modules/somepkg/test/cert.pem",
  "f /app/duckdb-extensions/v1.5.4/linux_arm64/spatial.duckdb_extension",
  "f /app/duckdb-extensions/v1.5.4/linux_arm64/spatial.duckdb_extension.info",
  "d /app/public",
  "f /app/public/favicon.svg",
  "f /app/src/lib/api/errors.ts",
  "d /app/src/app/api/published/[token]",
  "f /app/scripts/journey.mjs",
  "f /app/LICENSE",
  "f /app/NOTICE",
];

describe("image inventory judge", () => {
  it("requires the catalogue and admits it only when tracked, with omission and untracked controls", () => {
    const line = `f ${MODEL_CATALOGUE_IMAGE_PATH}`;
    expect(cataloguePresence([line])).toEqual([]);
    expect(cataloguePresence(CLEAN)).toEqual(["MISSING: /app/src/lib/assistant/model-catalogue.json"]);
    expect(judge([line], new Set([MODEL_CATALOGUE_REPO_PATH]))).toEqual([]);
    expect(judge([line], new Set())).toContain(`file the repository does not track: ${MODEL_CATALOGUE_IMAGE_PATH}`);
    expect(trackedManifest().has(MODEL_CATALOGUE_REPO_PATH)).toBe(true);
  });
  it("passes a clean composed listing — dependency fixtures included", () => {
    expect(judge(CLEAN)).toEqual([]);
  });

  it("fails on planted secrets, data, git metadata, and unknown entries", () => {
    const planted = judge([
      ...CLEAN,
      "f /app/data/secret.key",
      "f /app/data/metadata.sqlite",
      "f /app/.git/HEAD",
      "f /app/docs/self-host/backup-and-restore.md",
      "f /app/.env.production",
      "f /app/leftovers/scratch.txt",
    ]);
    expect(planted.some((v) => v.includes("secret key material"))).toBe(true);
    expect(planted.some((v) => v.includes("metadata database"))).toBe(true);
    expect(planted.some((v) => v.includes("live data directory"))).toBe(true);
    expect(planted.some((v) => v.includes("git metadata"))).toBe(true);
    expect(planted.some((v) => v.includes("docs / specs"))).toBe(true);
    expect(
      planted.some((v) => v.includes("unexpected top-level entry: leftovers")),
    ).toBe(true);
    expect(
      planted.some((v) => v.includes("unexpected top-level entry: .env")),
    ).toBe(true);
  });

  it("a key file hidden deep inside an allowed tree still fails", () => {
    const planted = judge([...CLEAN, "f /app/public/backup/secret.key"]);
    expect(planted.some((v) => v.includes("secret key material"))).toBe(true);
  });

  it("the stray bare-name environment file stays outside the top-level allowlist", () => {
    const planted = judge([...CLEAN, "f /app/ids.env"]);
    expect(planted).toContain(
      "unexpected top-level entry: ids.env (from /app/ids.env)",
    );
    // This filename is not the dot-env class above. The exact top-level
    // inventory rule is the permanent red guard for that leak.
    expect(planted.some((v) => v.includes("environment file"))).toBe(false);
  });

  it("nested files of a class a source tree never holds fail — the review's examples", () => {
    const planted = judge([
      ...CLEAN,
      "f /app/src/private-signing-key.pem",
      "f /app/scripts/db-dump.sql",
      "f /app/src/deep/nested/id_rsa",
      "f /app/public/notes.txt",
      "f /app/duckdb-extensions/v1.5.4/linux_arm64/rogue.so",
    ]);
    expect(
      planted.some(
        (v) =>
          v.includes("file class the src/ tree never holds") &&
          v.includes("private-signing-key.pem"),
      ),
    ).toBe(true);
    expect(
      planted.some((v) => v.includes("key or certificate material")),
    ).toBe(true);
    expect(
      planted.some(
        (v) =>
          v.includes("file class the scripts/ tree never holds") &&
          v.includes("db-dump.sql"),
      ),
    ).toBe(true);
    expect(planted.some((v) => v.includes("database or dump file"))).toBe(
      true,
    );
    expect(
      planted.some(
        (v) =>
          v.includes("file class the src/ tree never holds") &&
          v.includes("id_rsa"),
      ),
    ).toBe(true);
    expect(
      planted.some(
        (v) =>
          v.includes("file class the public/ tree never holds") &&
          v.includes("notes.txt"),
      ),
    ).toBe(true);
    expect(
      planted.some((v) =>
        v.includes("file class the extension bundle never holds"),
      ),
    ).toBe(true);
  });

  it("a source-tree file the repository does not track fails, even with a legitimate extension", () => {
    const tracked = new Set([
      "src/lib/api/errors.ts",
      "public/favicon.svg",
      "scripts/journey.mjs",
    ]);
    const planted = judge(
      [...CLEAN, "f /app/src/private-config.json", "f /app/public/exported-credentials.json"],
      tracked,
    );
    expect(
      planted.some(
        (v) =>
          v.includes("file the repository does not track") &&
          v.includes("private-config.json"),
      ),
    ).toBe(true);
    expect(
      planted.some(
        (v) =>
          v.includes("file the repository does not track") &&
          v.includes("exported-credentials.json"),
      ),
    ).toBe(true);
    // The tracked files themselves stay green under the same manifest.
    expect(judge(CLEAN, tracked)).toEqual([]);
  });

  it("admits an application-owned public worker only when the manifest tracks it", () => {
    const worker = `f ${MVT_WORKER_IMAGE_PATH}`;
    const tracked = new Set([
      "src/lib/api/errors.ts",
      "public/favicon.svg",
      MVT_WORKER_REPO_PATH,
      "scripts/journey.mjs",
    ]);

    expect(judge([...CLEAN, worker], tracked)).toEqual([]);
    expect(judge([...CLEAN, worker], new Set())).toContain(
      `file the repository does not track: ${MVT_WORKER_IMAGE_PATH}`,
    );
    expect(
      judge(
        [...CLEAN, "f /app/src/unexpected.js"],
        new Set([...tracked, "src/unexpected.js"]),
      ),
    ).toContain("file class the src/ tree never holds: /app/src/unexpected.js");
  });

  it("the manifest generator reflects git — this very test file is tracked once committed", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const tracked = trackedManifest(root) as Set<string>;
    expect(tracked.has("src/lib/api/errors.ts")).toBe(true);
    expect(tracked.has("src/lib/no-such-file.ts")).toBe(false);
  });
});

// The shipped templates are the one top-level entry the image gained for
// them, held to documents, datasets and pictures, each file one git tracks.
describe("the shipped templates in the image", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const TEMPLATE_FILES = [
    "templates/index.json",
    "templates/harbour/1/project.json",
    "templates/harbour/1/datasets/stations.parquet",
    "templates/harbour/1/pictures/light.png",
  ];
  const listing = TEMPLATE_FILES.map((f) => `f /app/${f}`);

  it("requires the shipped index and admits the folder's classes when tracked", () => {
    expect(TOP_LEVEL_ALLOWLIST.has("templates")).toBe(true);
    expect(templatesPresence([...CLEAN, ...listing])).toEqual([]);
    expect(templatesPresence(CLEAN)).toEqual([`MISSING: ${SHIPPED_TEMPLATES_INDEX_IMAGE_PATH}`]);
    expect(judge([...CLEAN, ...listing], new Set([...TEMPLATE_FILES, "src/lib/api/errors.ts", "public/favicon.svg", "scripts/journey.mjs"]))).toEqual([]);
    expect(trackedManifest(root).has("templates/index.json")).toBe(true);
  });

  it("refuses a class the folder never holds, and a file the repository does not track", () => {
    const tracked = new Set([...TEMPLATE_FILES, "templates/harbour/1/notes.txt", "templates/harbour/1/run.ts", "templates/harbour/1/map.svg"]);
    const planted = judge([
      ...listing,
      "f /app/templates/harbour/1/notes.txt",
      "f /app/templates/harbour/1/run.ts",
      "f /app/templates/harbour/1/map.svg",
      "f /app/templates/harbour/1/extra.parquet",
    ], tracked);
    expect(planted).toEqual([
      "file class the templates/ tree never holds: /app/templates/harbour/1/notes.txt",
      "file class the templates/ tree never holds: /app/templates/harbour/1/run.ts",
      "file class the templates/ tree never holds: /app/templates/harbour/1/map.svg",
      "file the repository does not track: /app/templates/harbour/1/extra.parquet",
    ]);
  });

  it("admits nothing else new: a dataset or picture outside the folder still fails", () => {
    const planted = judge([
      ...CLEAN,
      "f /app/stray.parquet",
      "f /app/src/lib/data.parquet",
      "f /app/public/picture.png",
    ], new Set(["src/lib/data.parquet", "public/picture.png", "src/lib/api/errors.ts", "public/favicon.svg", "scripts/journey.mjs"]));
    expect(planted).toEqual([
      "unexpected top-level entry: stray.parquet (from /app/stray.parquet)",
      "file class the src/ tree never holds: /app/src/lib/data.parquet",
      "file class the public/ tree never holds: /app/public/picture.png",
    ]);
  });

  it("reaches the image: the build context keeps the folder, and the runner copies it", () => {
    const ignored = dockerIgnore({ ignorecase: false }).add(readFileSync(join(root, ".dockerignore"), "utf8"));
    for (const file of TEMPLATE_FILES) expect(ignored.ignores(file), file).toBe(false);
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY --from=build --chown=node:node \/app\/templates \.\/templates$/m);
  });
});

const offlineScript = fileURLToPath(
  new URL("../../scripts/check-duckdb-extensions-offline.mjs", import.meta.url),
);
const emptyBundle = mkdtempSync(join(tmpdir(), "dezfil-ext-check-"));
afterAll(() => rmSync(emptyBundle, { recursive: true, force: true }));

describe("offline extension check", () => {
  it("fails red against a bundle with nothing baked, naming the gaps", () => {
    let code = 0;
    let output = "";
    try {
      execFileSync("node", [offlineScript, emptyBundle], {
        encoding: "utf8",
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
      });
    } catch (e) {
      const err = e as { status: number | null; stderr: string };
      code = err.status ?? -1;
      output = err.stderr ?? "";
    }
    expect(code).toBe(1);
    expect(output).toContain("MISSING: azure");
    expect(output).toContain("FAIL");
  }, 30_000);
});

it("requires the native reception dependency beside the ingress preload", () => {
  expect(ingressPresence([
    "f /app/scripts/ingress-preload.mjs", "f /app/scripts/preload-options.mjs", "f /app/src/lib/auth/ingress.mjs",
  ])).toEqual(["MISSING: /app/src/lib/auth/reception.mjs"]);
});
