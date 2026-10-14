/*
 * Undefined design-token check.
 *
 * Scope: src/app/globals.css and every *.module.css below src/. A var(--x)
 * reference must have a --x definition in an authored stylesheet or a
 * matching TS/TSX definition credit. A fallback does not excuse an undefined
 * head token: silently shipping the fallback is the defect class this
 * check exists to catch. Definitions nested in media queries or [data-theme]
 * blocks count because the scan covers the complete comment-free stylesheet.
 *
 * Deliberate CSS-module deviation from the spec's simple global-or-same-file
 * rule: definitions are credited tree-wide. The app intentionally inherits
 * module-authored properties across component boundaries: workspace screens
 * read --screen-height from the layout, while builder drawer/status modules
 * read --stage-left-base/--stage-left from MapBuilder's body rule. Static text
 * scanning cannot prove those DOM ancestor relationships without rejecting
 * these established patterns, so the ratchet credits them explicitly broadly.
 *
 * TS/TSX credits are deliberately narrow: inline-style/object-literal keys,
 * next/font's `variable:` property, and CSSOM setProperty names. Arbitrary
 * strings (including CLI flags), reads, comments, and prose do not define a
 * custom property. var(--...) references inside TS/TSX are not swept because
 * template-built names cannot be enumerated without false confidence; the
 * known latent example is WorkflowThumb's var(--grp-${...}) reference.
 *
 * Undefined references present when this check was adopted are enumerated in
 * scripts/token-inventory.json - the adoption leftover list, not license. The
 * check is a two-way ratchet: a finding missing from the inventory fails as
 * NEW, and an inventory row matching nothing fails as STALE.
 *
 * Usage: node scripts/check-tokens.mjs [rootDir]
 *   --write-inventory   regenerate the inventory from the current tree
 *                       (the seeding move; afterwards the ratchet holds)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_NAME = "--[A-Za-z0-9_-]+";

/** Blank comments and quoted strings while preserving newlines and offsets. */
export function codeOnly(css) {
  let out = "";
  let index = 0;
  let state = "code";
  let quote = "";

  while (index < css.length) {
    const char = css[index];
    const next = css[index + 1];

    if (state === "comment") {
      if (char === "*" && next === "/") {
        out += "  ";
        index += 2;
        state = "code";
      } else {
        out += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (state === "string") {
      if (char === "\\" && next !== undefined) {
        out += char === "\n" ? "\n" : " ";
        out += next === "\n" ? "\n" : " ";
        index += 2;
      } else if (char === quote) {
        out += " ";
        index += 1;
        state = "code";
      } else {
        out += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      out += "  ";
      index += 2;
      state = "comment";
    } else if (char === '"' || char === "'") {
      out += " ";
      index += 1;
      state = "string";
      quote = char;
    } else {
      out += char;
      index += 1;
    }
  }

  return out;
}

export function definitionsIn(css) {
  const source = codeOnly(css);
  const definitions = new Set();
  const pattern = new RegExp(`(^|[;{])\\s*(${TOKEN_NAME})\\s*:`, "gm");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    definitions.add(match[2]);
  }
  return definitions;
}

/** Custom-property names in TS/TSX contexts that actually define them. */
export function scriptDefinitionCredits(source) {
  const definitions = new Set();
  const patterns = [
    new RegExp(
      `(?:^|[,{])\\s*(?:\\[\\s*)?([\"'\x60])(${TOKEN_NAME})\\1` +
        `(?:\\s+as\\s+(?:string|const))?\\s*\\]?\\s*:`,
      "gm",
    ),
    new RegExp(`\\bvariable\\s*:\\s*([\"'\x60])(${TOKEN_NAME})\\1`, "g"),
    new RegExp(`\\.setProperty\\(\\s*([\"'\x60])(${TOKEN_NAME})\\1\\s*,`, "g"),
  ];
  for (const pattern of patterns) {
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      definitions.add(match[2]);
    }
  }
  return definitions;
}

/** Undefined references in one stylesheet, one result per occurrence. */
export function undefinedReferences(css, file, globalDefinitions = new Set()) {
  const source = codeOnly(css);
  const localDefinitions = definitionsIn(css);
  const missing = [];
  const pattern = new RegExp(`var\\(\\s*(${TOKEN_NAME})`, "g");

  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const token = match[1];
    if (globalDefinitions.has(token) || localDefinitions.has(token)) {
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    missing.push({ file, token, line });
  }

  return missing;
}

function walk(dir, keep) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full, keep));
    else if (keep(full)) files.push(full);
  }
  return files;
}

export function checkTree(root) {
  const globalsPath = path.join(root, "src", "app", "globals.css");
  const srcPath = path.join(root, "src");
  const files = [globalsPath, ...walk(srcPath, (file) => file.endsWith(".module.css"))];
  const definitionCredits = new Set();
  for (const file of files) {
    for (const token of definitionsIn(readFileSync(file, "utf8"))) {
      definitionCredits.add(token);
    }
  }
  for (const file of walk(srcPath, (candidate) => /\.tsx?$/.test(candidate))) {
    for (const token of scriptDefinitionCredits(readFileSync(file, "utf8"))) {
      definitionCredits.add(token);
    }
  }
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");

  return files
    .flatMap((file) =>
      undefinedReferences(
        readFileSync(file, "utf8"),
        relative(file),
        definitionCredits,
      ),
    )
    .sort((a, b) =>
      a.file === b.file
        ? byCodePoint(a.token, b.token)
        : byCodePoint(a.file, b.file),
    );
}

// Match the stored inventory independent of the host locale.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const keyOf = (row) => [row.file, row.token].join("\t");

export function toRows(findings) {
  const rows = new Map();
  for (const finding of findings) {
    const key = keyOf(finding);
    const row = rows.get(key);
    if (row) row.count += 1;
    else rows.set(key, { file: finding.file, token: finding.token, count: 1 });
  }
  return [...rows.values()].sort((a, b) =>
    a.file === b.file
      ? byCodePoint(a.token, b.token)
      : byCodePoint(a.file, b.file),
  );
}

/** The two-way ratchet: new findings and stale inventory rows both fail. */
export function judge(rows, inventory) {
  const found = new Map(rows.map((row) => [keyOf(row), row.count]));
  const listed = new Map(inventory.map((row) => [keyOf(row), row.count]));
  const problems = [];

  for (const row of rows) {
    const allowed = listed.get(keyOf(row)) ?? 0;
    if (row.count > allowed) {
      problems.push(
        `NEW: ${row.file} - ${row.token} x${row.count - allowed}`,
      );
    }
  }
  for (const row of inventory) {
    const present = found.get(keyOf(row)) ?? 0;
    if (present < row.count) {
      problems.push(
        `STALE: ${row.file} - ${row.token} listed x${row.count}, found x${present}` +
          " (heal the inventory in the same change)",
      );
    }
  }
  return problems;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write-inventory");
  const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
  const inventoryPath = path.join(root, "scripts", "token-inventory.json");
  const rows = toRows(checkTree(root));
  if (writeMode) {
    writeFileSync(inventoryPath, JSON.stringify(rows, null, 2) + "\n");
    console.log(`WROTE - ${rows.length} inventory row(s) to ${inventoryPath}`);
    process.exit(0);
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const problems = judge(rows, inventory);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error(`FAIL - ${problems.length} token-inventory violation(s).`);
    process.exit(1);
  }
  console.log(`PASS - design-token references resolve (${rows.length} inventoried leftover(s) unchanged).`);
}
