// The stage's left edge appears once.
//
// It used to be a literal in eight CSS sites, with four more derived from it by
// hand and a parallel set restating every one below the breakpoint, plus a
// thirteenth copy in component code for the camera's padding. Twelve places had
// to agree for one edge to move — and two of them already did not: the timeline
// dock re-derived its offset at the narrow breakpoint while the status pill's
// identical offset had no media query in its file at all, leaving the two 18 px
// apart in fullscreen (known issue).
//
// A drawer moves that edge on every drag. So it is one custom property now, and
// this is the check that keeps it one: without it the property is a convention,
// and conventions lose to the next hurried diff — which is precisely what the
// duplicated constant did on its own, before anything asked it to animate.
//
//   node scripts/check-stage-edge.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SEARCH = path.join(ROOT, "src");

/** The two values the edge takes, at the two breakpoints. */
const EDGE_LITERALS = [/\b438px\b/g, /\b402px\b/g];

/** Where the property is allowed to be written out — its definition. */
const DEFINITION = "src/components/builder/MapBuilder.module.css";

/** Values derived from the edge by hand, which must now be expressions. */
const DERIVED = [/\b484px\b/g, /\bcalc\(50% \+ 212px\)/g, /\bcalc\(50% \+ 194px\)/g];

/** The right edge's one expression: the gutter plus
 * what a docked assistant adds. It has no bare literal of its own to
 * hold, so the check holds the expression that defines `--stage-right`
 * to one copy, in the definition, and every other site reads the
 * property. A second copy anywhere is a second definition. */
const RIGHT_EXPRESSION = /calc\(\s*var\(--gutter\)\s*\+\s*var\(--assistant-offset\)\s*\)/g;
const RIGHT_DEFINITION = /--stage-right\s*:/g;

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(css|tsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

const problems = [];
let definitions = 0;
let rightDefinitions = 0;

for (const file of files(SEARCH)) {
  const rel = path.relative(ROOT, file);
  const source = readFileSync(file, "utf8");

  for (const pattern of EDGE_LITERALS) {
    const hits = [...source.matchAll(pattern)];
    if (hits.length === 0) continue;
    if (rel === DEFINITION) {
      definitions += hits.length;
      // Even in the definition, each value may be written exactly once.
      if (hits.length > 1) {
        problems.push(
          `${rel}: the edge value ${hits[0][0]} appears ${hits.length} times in its own definition`,
        );
      }
      continue;
    }
    problems.push(
      `${rel}: writes the stage edge (${hits[0][0]}) instead of reading var(--stage-left)`,
    );
  }

  for (const pattern of DERIVED) {
    const hits = [...source.matchAll(pattern)];
    if (hits.length > 0) {
      problems.push(
        `${rel}: hand-derives from the stage edge (${hits[0][0]}) instead of an expression over var(--stage-left)`,
      );
    }
  }

  const rightHits = [...source.matchAll(RIGHT_EXPRESSION)].length + [...source.matchAll(RIGHT_DEFINITION)].length;
  if (rightHits > 0) {
    if (rel === DEFINITION) {
      rightDefinitions += rightHits;
      // One `--stage-right:` and one expression, in the definition.
      if (rightHits > 2) {
        problems.push(`${rel}: the stage's right edge is defined ${rightHits - 1} times in its own definition`);
      }
    } else {
      problems.push(
        `${rel}: writes the stage's right edge instead of reading var(--stage-right)`,
      );
    }
  }
}

// The one copy this check cannot see as a literal: the TSX fallback, which is
// a bare number rather than a length. It is not a second definition — it is
// what the shell uses before the browser has computed anything — but it is a
// number that must agree with the wide breakpoint's, and nothing else would
// notice if it stopped agreeing.
const FALLBACK_FILE = "src/components/builder/use-stage-edge.ts";
const fallbackSource = readFileSync(path.join(ROOT, FALLBACK_FILE), "utf8");
const fallback = /FALLBACK_EDGE\s*=\s*(\d+)/.exec(fallbackSource)?.[1];
const wide = /--stage-left-base:\s*(\d+)px/.exec(
  readFileSync(path.join(ROOT, DEFINITION), "utf8"),
)?.[1];
if (fallback === undefined || wide === undefined) {
  problems.push(
    `${FALLBACK_FILE}: could not read FALLBACK_EDGE or the wide breakpoint — ` +
      `this cross-check is now blind`,
  );
} else if (fallback !== wide) {
  problems.push(
    `${FALLBACK_FILE}: FALLBACK_EDGE is ${fallback} but the wide breakpoint is ` +
      `${wide}px — the first paint would frame the map for a layout that is not there`,
  );
}

// A check that found nothing to check is not a passing check.
if (rightDefinitions !== 2) {
  problems.push(
    `${DEFINITION}: expected the right edge defined once (\`--stage-right\` and its expression), found ${rightDefinitions} — ` +
      `the property may have been renamed, in which case this check is now blind`,
  );
}
if (definitions !== EDGE_LITERALS.length) {
  problems.push(
    `${DEFINITION}: expected ${EDGE_LITERALS.length} edge definitions, found ${definitions} — ` +
      `the property may have been renamed, in which case this check is now blind`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\nFAIL — the stage's left edge must appear exactly once, as ` +
      `\`--stage-left-base\` in ${DEFINITION}, and its right edge once, as ` +
      `\`--stage-right\` there. Every other site reads var(--stage-left), ` +
      `var(--stage-right) or an expression over them.`,
  );
  process.exit(1);
}

console.log(
  `PASS — the stage's left edge is defined once (${definitions} breakpoint ` +
    `values), its right edge once, and both are read everywhere else.`,
);
