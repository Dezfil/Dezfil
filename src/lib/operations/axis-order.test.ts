import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Axis order is stated in the SQL, every time.
 *
 * **Configuration cannot carry this.** The hardened instance where user SQL
 * runs locks its settings before serving anything, so nothing running there can
 * set the engine's axis-order switch; the ellipsoidal measurement family takes
 * no per-call override either. And the pinned build documents its current
 * default as **expected to change**, which would make a version bump a silent
 * result change for every measurement in the product — no error, no null, and
 * nothing on screen.
 *
 * So this is a sweep, not a spot check. A verb added later that forgets is
 * exactly the regression that would otherwise ship invisibly, and a per-verb
 * assertion cannot catch a verb nobody thought to assert.
 */

const SOURCE = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The **DuckDB** road only.
 *
 * `postgis/access.ts` builds SQL for a remote PostGIS server, whose
 * `ST_Transform` takes an SRID and offers no axis-order argument at all — a
 * different function in a different engine, reached over the wire. Sweeping it
 * would be asserting that one engine's SQL carries another engine's parameter.
 */
const NOT_OUR_ENGINE = ["src/lib/postgis/"];

/** One call's own text: from `ST_Transform(` to the parenthesis that closes it. */
function balanced(src: string, start: number): string {
  let depth = 0;
  for (let i = src.indexOf("(", start); i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** Every `ST_Transform(` call the product's own source generates. */
function transformCalls(): { file: string; call: string }[] {
  const found: { file: string; call: string }[] = [];
  for (const file of sourceFiles(SOURCE)) {
    const rel = path.relative(process.cwd(), file);
    if (NOT_OUR_ENGINE.some((prefix) => rel.startsWith(prefix))) continue;
    const src = readFileSync(file, "utf8");
    // **One call, bounded by its own parentheses.** A fixed-width slice reads
    // into whatever follows, so a transform that lost its axis order would be
    // covered by its neighbour's — the sweep passing because of the very call
    // it is not checking. Balancing the parens keeps each call answerable for
    // itself.
    for (const match of src.matchAll(/ST_Transform\(/g)) {
      found.push({ file: rel, call: balanced(src, match.index!) });
    }
  }
  return found;
}

describe("every generated transform states its axis order", () => {
  const calls = transformCalls();

  it("finds transforms to sweep, so the sweep is not vacuously green", () => {
    // Without this the whole file passes if the regex ever stops matching.
    expect(calls.length).toBeGreaterThan(4);
  });

  it("leaves none of them to engine configuration", () => {
    // Two accepted spellings: the named argument the ingest and measurement
    // paths use, and the positional `true` the binning path has used since
    // 0047. Both state it; neither depends on a setting.
    const silent = calls.filter(
      (c) => !/always_xy\s*:?=?\s*true|,\s*true\s*\)/.test(c.call),
    );
    expect(
      silent.map((c) => `${c.file}: ${c.call.trim().slice(0, 80)}`),
    ).toEqual([]);
  });

  it("includes the measurement path, so the sweep covers what this spec added", () => {
    expect(calls.some((c) => c.file.includes("operations/measurement"))).toBe(true);
  });
});

describe("the sweep is bounded to the call it is checking", () => {
  it("does not let a neighbouring call satisfy it", () => {
    // The failure mode a fixed-width slice has: two calls on adjacent lines,
    // the first missing its axis order and the second carrying one. If this
    // ever stops finding the first, the sweep above is decorative.
    const source =
      "const a = `ST_Transform(g, 'EPSG:4326', crs)`;\n" +
      "const b = `ST_Transform(g, crs, 'EPSG:4326', always_xy := true)`;\n";
    const calls = [...source.matchAll(/ST_Transform\(/g)].map((m) =>
      balanced(source, m.index!),
    );
    expect(calls).toHaveLength(2);
    expect(/always_xy/.test(calls[0])).toBe(false);
    expect(/always_xy/.test(calls[1])).toBe(true);
  });
});
