import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The client boundary (verification): a client component that reaches
 * a server-only module through a value import breaks the page at compile
 * time — Next cannot bundle better-sqlite3 for the browser — and neither
 * tsc nor the unit suite sees it. The workflow screen shipped exactly that
 * once (the canvas importing the name rule's module, which opens the
 * metadata database) and the page answered 500. This walks the value
 * imports from the workflow screen and fails on the first server module.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SERVER_ONLY = [/\/lib\/metadata\/db\.ts$/, /\/lib\/duckdb\//, /\/lib\/table-service\.ts$/, /\/lib\/operations\/output-names\.ts$/];
const EXTERNAL_SERVER = new Set(["better-sqlite3", "duckdb", "node:fs", "fs", "node:path"]);

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Value imports only: `import type` and `import { type X }` carry no code. */
function valueImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /^import\s+(type\s+)?([^'"]*?)\s*from\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) continue;
    const clause = m[2].trim();
    // `{ type A, type B }` is type-only too.
    const inner = clause.startsWith("{") ? clause.slice(1, -1) : null;
    if (inner !== null && inner.split(",").every((s) => s.trim() === "" || s.trim().startsWith("type "))) continue;
    out.push(m[3]);
  }
  return out;
}

function walk(entry: string): { file: string; via: string[] } | null {
  const seen = new Set<string>();
  const stack: { file: string; via: string[] }[] = [{ file: entry, via: [] }];
  while (stack.length) {
    const { file, via } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(file)) {
      if (EXTERNAL_SERVER.has(spec)) return { file: spec, via: [...via, file] };
      const resolved = resolveImport(file, spec);
      if (!resolved) continue;
      if (/\.test\.tsx?$/.test(resolved)) continue;
      if (SERVER_ONLY.some((p) => p.test(resolved))) return { file: resolved, via: [...via, file] };
      stack.push({ file: resolved, via: [...via, file] });
    }
  }
  return null;
}

describe("the client boundary", () => {
  it("is red for the defect it exists to catch: a value import of the name rule's module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-boundary-"));
    const seed = path.join(dir, "seed.tsx");
    fs.writeFileSync(seed, 'import { registeredOutputName } from "@/lib/operations/output-names";\nexport const x = registeredOutputName;\n');
    const hit = walk(seed);
    expect(hit?.file).toMatch(/output-names\.ts$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the workflow screen reaches no server-only module through a value import", () => {
    const hit = walk(path.join(ROOT, "src/components/WorkflowScreen.tsx"));
    expect(hit, hit ? `${hit.file} reached via\n  ${hit.via.map((f) => path.relative(ROOT, f)).join("\n  → ")}` : "").toBeNull();
  });
});
