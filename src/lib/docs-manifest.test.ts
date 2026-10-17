// The image manifest's rules in `npm run lint:docs`: every picture and
// recording has a row and is used, every row's size, bytes and length are
// the file's own, the size is the frame or the declared crop at two pixels
// per CSS pixel, and every file is within its bound. A valid tree passes,
// and each rule is seeded red on its own, over real WebP bytes and WebM
// documents.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS gates, no declaration files on purpose.
import { checkManifest } from "../../scripts/docs-manifest.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { checkTree } from "../../scripts/docs-contract.mjs";
import { noisyWebp, webm, webp } from "../../test-support/media-fixtures";

type Problem = { file: string; rule: string; message: string };
type Row = Record<string, unknown>;
type Tree = Record<string, string | Buffer>;

const page = (body: string) => `---
title: "Templates"
summary: "The finished maps and workflow examples an instance offers."
read_when:
  - "you want a finished map to start from"
audience:
  - user
checked: none
---

## The page

${body}
`;
const row = (file: string, scene: string, kind: string, bytes: Buffer, width: number, height: number, extra: Row = {}): Row =>
  ({ file, scene, kind, version: "0.1.0", date: "2026-10-17", width, height, bytes: bytes.length, ...extra });

let picture: Buffer, poster: Buffer, card: Buffer, small: Buffer;
const recording = webm();
beforeAll(async () => {
  [picture, poster, card, small] = await Promise.all([webp(2880, 1800), webp(2880, 1800, { r: 1, g: 2, b: 3 }), webp(200, 100), webp(1000, 600)]);
});

function base(): { tree: Tree; rows: Row[] } {
  const rows = [
    row("guides/search-poster.webp", "search", "picture", poster, 2880, 1800),
    row("guides/search.webm", "search", "recording", recording, 2880, 1800, { length: 5, poster: "guides/search-poster.webp" }),
    row("guides/templates.webp", "templates", "picture", picture, 2880, 1800),
    row("start/card.webp", "card", "picture", card, 200, 100, { crop: { x: 10, y: 20, width: 100, height: 50 } }),
  ];
  const tree: Tree = {
    "README.md": "# Dezfil\n\n![The setup card](docs/images/start/card.webp)\n",
    "docs/guides/templates.md": page("![The Templates page](../images/guides/templates.webp)\n\n![Searching the templates](../images/guides/search.webm)"),
    "docs/images/guides/templates.webp": picture,
    "docs/images/guides/search.webm": recording,
    "docs/images/guides/search-poster.webp": poster,
    "docs/images/start/card.webp": card,
  };
  return { tree, rows };
}

function check(tree: Tree, rows: Row[] | null, manifestText?: string): Problem[] {
  const files: Tree = { ...tree };
  if (rows) files["docs/images/manifest.json"] = manifestText ?? JSON.stringify({ rows });
  const read = (file: string) => String(files[file]);
  const readBytes = (file: string) => Buffer.from(files[file]);
  const { used, problems } = checkTree({ files: Object.keys(files), read, on: "2026-10-17" }) as { used: Set<string>; problems: Problem[] };
  expect(problems.filter((p) => p.rule !== "image.not-in-manifest")).toEqual([]);
  return checkManifest({ files: Object.keys(files), read, readBytes, used });
}
const shape = (problems: Problem[]) => problems.map(({ file, rule }) => ({ file, rule }));

type Seed = { name: string; make: (b: { tree: Tree; rows: Row[] }) => Promise<void> | void; problems: { file: string; rule: string }[]; manifest?: (rows: Row[]) => string };
const at = (file: string) => (f: Row) => f.file === file;
const seeds: Seed[] = [
  {
    name: "a picture over 250,000 bytes",
    async make({ tree, rows }) {
      const big = await noisyWebp(2880, 1800);
      tree["docs/images/guides/templates.webp"] = big;
      rows.find(at("guides/templates.webp"))!.bytes = big.length;
    },
    problems: [{ file: "docs/images/guides/templates.webp", rule: "manifest.picture-bytes" }],
  },
  {
    name: "a recording over 1,500,000 bytes",
    make({ tree, rows }) {
      const big = webm({ payload: 1_500_001 });
      tree["docs/images/guides/search.webm"] = big;
      rows.find(at("guides/search.webm"))!.bytes = big.length;
    },
    problems: [{ file: "docs/images/guides/search.webm", rule: "manifest.recording-bytes" }],
  },
  {
    name: "a recording over eight seconds",
    make({ tree, rows }) {
      const long = webm({ duration: 8100 });
      tree["docs/images/guides/search.webm"] = long;
      Object.assign(rows.find(at("guides/search.webm"))!, { bytes: long.length, length: 8.1 });
    },
    problems: [{ file: "docs/images/guides/search.webm", rule: "manifest.recording-length" }],
  },
  {
    name: "a thirteenth recording",
    make({ tree, rows }) {
      const links = [];
      for (let i = 1; i <= 12; i += 1) {
        tree[`docs/images/guides/more-${i}.webm`] = recording;
        rows.push(row(`guides/more-${i}.webm`, `more-${i}`, "recording", recording, 2880, 1800, { length: 5, poster: "guides/search-poster.webp" }));
        links.push(`![Loop ${i}](../images/guides/more-${i}.webm)`);
      }
      tree["docs/guides/templates.md"] = page(`![The Templates page](../images/guides/templates.webp)\n\n![Searching the templates](../images/guides/search.webm)\n\n${links.join("\n\n")}`);
    },
    problems: [{ file: "docs/images", rule: "manifest.recording-count" }],
  },
  {
    name: "an orphan file, with no row and no use",
    make({ tree }) { tree["docs/images/guides/orphan.webp"] = picture; },
    problems: [{ file: "docs/images/guides/orphan.webp", rule: "manifest.unused" }, { file: "docs/images/guides/orphan.webp", rule: "manifest.no-row" }],
  },
  {
    name: "a file with a row that nothing uses",
    make({ tree, rows }) {
      tree["docs/images/guides/spare.webp"] = picture;
      rows.push(row("guides/spare.webp", "spare", "picture", picture, 2880, 1800));
    },
    problems: [{ file: "docs/images/guides/spare.webp", rule: "manifest.unused" }],
  },
  {
    name: "a row with the wrong byte count",
    make({ rows }) { (rows.find(at("guides/templates.webp"))!.bytes as number) += 1; },
    problems: [{ file: "docs/images/guides/templates.webp", rule: "manifest.bytes" }],
  },
  {
    name: "a row with the wrong size",
    make({ rows }) { rows.find(at("start/card.webp"))!.height = 101; },
    problems: [{ file: "docs/images/start/card.webp", rule: "manifest.dimensions" }],
  },
  {
    name: "a row with the wrong length",
    make({ rows }) { rows.find(at("guides/search.webm"))!.length = 5.1; },
    problems: [{ file: "docs/images/guides/search.webm", rule: "manifest.length" }],
  },
  {
    name: "a picture that is neither the frame nor its declared crop at two pixels per CSS pixel",
    make({ tree, rows }) {
      tree["docs/images/guides/templates.webp"] = small;
      Object.assign(rows.find(at("guides/templates.webp"))!, { bytes: small.length, width: 1000, height: 600 });
    },
    problems: [{ file: "docs/images/guides/templates.webp", rule: "manifest.frame" }],
  },
  {
    name: "a row for the manifest itself",
    make({ rows }) { rows.push({ file: "manifest.json" }); },
    problems: [{ file: "docs/images/manifest.json", rule: "manifest.self-row" }],
  },
  {
    name: "two rows for one file",
    make({ rows }) { rows.push({ ...rows.find(at("guides/templates.webp"))! }); },
    problems: [{ file: "docs/images/manifest.json", rule: "manifest.duplicate-row" }],
  },
  {
    name: "a row whose kind is not its file's",
    make({ rows }) { rows.find(at("guides/templates.webp"))!.kind = "recording"; },
    problems: [{ file: "docs/images/manifest.json", rule: "manifest.row-form" }, { file: "docs/images/guides/templates.webp", rule: "manifest.no-row" }],
  },
  {
    name: "a manifest with a field besides rows",
    make() { /* the manifest text below */ },
    manifest: (rows) => JSON.stringify({ rows, note: "x" }),
    problems: [{ file: "docs/images/manifest.json", rule: "manifest.row-form" }],
  },
  {
    name: "a row whose file is gone",
    make({ tree }) { delete tree["docs/images/start/card.webp"]; tree["README.md"] = "# Dezfil\n"; },
    problems: [{ file: "docs/images/manifest.json", rule: "manifest.missing-file" }],
  },
  {
    name: "the README using a file that does not exist",
    make({ tree }) { tree["README.md"] = "# Dezfil\n\n![The setup card](docs/images/start/card.webp)\n\n![Gone](docs/images/start/gone.webp)\n"; },
    problems: [{ file: "README.md", rule: "manifest.missing-file" }],
  },
  {
    name: "the README using a file with no row",
    make({ tree, rows }) { rows.splice(rows.findIndex(at("start/card.webp")), 1); void tree; },
    problems: [{ file: "README.md", rule: "manifest.no-row" }, { file: "docs/images/start/card.webp", rule: "manifest.no-row" }],
  },
  {
    name: "a recording whose poster has no row",
    make({ tree, rows }) {
      rows.splice(rows.findIndex(at("guides/search-poster.webp")), 1);
      void tree;
    },
    problems: [{ file: "docs/images/manifest.json", rule: "manifest.poster" }, { file: "docs/images/guides/search-poster.webp", rule: "manifest.no-row" }],
  },
  {
    name: "a file that is not what its name says",
    make({ tree }) { tree["docs/images/guides/templates.webp"] = "not a picture"; },
    problems: [{ file: "docs/images/guides/templates.webp", rule: "manifest.unreadable-file" }],
  },
];

describe("the image manifest's rules", () => {
  it("accept a tree whose every file has a true row and a use, the README's and a poster's included", () => {
    const { tree, rows } = base();
    expect(check(tree, rows)).toEqual([]);
  });

  it.each(seeds)("refuse $name", async ({ make, problems, manifest }) => {
    const b = base();
    await make(b);
    const found = check(b.tree, b.rows, manifest?.(b.rows));
    expect(shape(found)).toEqual(problems);
    expect(found.every((p) => p.message.length > 0)).toBe(true);
  });

  it("seed every rule the module names", () => {
    const named = new Set([...readFileSync("scripts/docs-manifest.mjs", "utf8").matchAll(/"(manifest\.(?!json")[a-z-]+)"/g)].map((m) => m[1]));
    const seeded = new Set(seeds.flatMap((s) => s.problems.map((p) => p.rule)));
    expect(named.size).toBeGreaterThan(12);
    for (const rule of named) expect(seeded, rule).toContain(rule);
  });
});

describe("lint:docs over a tree on disk", () => {
  const script = fileURLToPath(new URL("../../scripts/docs.mjs", import.meta.url));
  const folder = mkdtempSync(join(tmpdir(), "dezfil-docs-manifest-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const run = (mode: string) => {
    try { return { code: 0, output: execFileSync(process.execPath, [script, mode, "--root", folder], { encoding: "utf8", stdio: "pipe" }) }; }
    catch (error) { const e = error as { status: number; stdout: string; stderr: string }; return { code: e.status, output: e.stdout + e.stderr }; }
  };

  it("passes the true manifest and names the file and rule of a wrong byte count", () => {
    const { tree, rows } = base();
    for (const [file, content] of Object.entries({ ...tree, "docs/images/manifest.json": JSON.stringify({ rows }, null, 2) })) {
      mkdirSync(dirname(join(folder, file)), { recursive: true });
      writeFileSync(join(folder, file), content);
    }
    for (const imported of ["CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"]) writeFileSync(join(folder, imported), `# ${imported}\n`);
    expect(run("--write").code).toBe(0);
    expect(run("--check")).toMatchObject({ code: 0 });
    (rows.find(at("guides/search.webm"))!.bytes as number) -= 1;
    writeFileSync(join(folder, "docs/images/manifest.json"), JSON.stringify({ rows }, null, 2));
    const failed = run("--check");
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("docs/images/guides/search.webm: manifest.bytes:");
  });
});
