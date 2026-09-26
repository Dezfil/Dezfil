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
  MODEL_CATALOGUE_REPO_PATH,
  MODEL_CATALOGUE_IMAGE_PATH,
  MVT_WORKER_IMAGE_PATH,
  MVT_WORKER_REPO_PATH,
  TOP_LEVEL_ALLOWLIST,
  trackedManifest,
} from "../../scripts/check-image-inventory.mjs";

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
      "f /app/docs/runbook.md",
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
