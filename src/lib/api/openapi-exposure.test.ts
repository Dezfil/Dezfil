import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { ERROR_CATALOGUE } from "./error-catalogue";

/**
 * The served contract is a public surface three times over: the JSON
 * document, the generated agent tool descriptions built from it, and the
 * rendered developer page. Nothing in it may cite an internal document
 * that the published repository does not ship, because such a citation
 * resolves to nothing for every reader who meets it.
 *
 * The pattern below catches every citation form this project used to
 * carry: a planning-document number, a tracking row, a path into a folder
 * the published repository drops, and a phase name. The document also holds the error catalogue, under the
 * x-error-codes extension, so the catalogue is covered by the same run;
 * it is asserted again on its own so a future document that stopped
 * serving it would not silently drop the check.
 */
const INTERNAL_CITATION = new RegExp(
  [
    // a planning-document number, bare or parenthesised
    "spec [0-9]{4}",
    // a tracking row
    "\\bN-[0-9]+\\b",
    // a path into a folder the published repository does not carry
    "\\b(?:sdd|research)/[\\w./-]+",
    "\\bdocs/(?:phases|known-issues|assessments)[\\w./-]*",
    "\\bdesign/prototypes/[\\w./-]*",
    "\\.claude/[\\w./-]+",
    // a phase name
    "\\bPhase [0-9]+(?:\\.[0-9]+)?\\b",
    "\\bphase-[0-9]+(?:\\.[0-9]+)?\\b",
  ].join("|"),
);

/** Every string in the value, with the path it sits at. */
function strings(node: unknown, path: string, out: Array<[string, string]>) {
  if (typeof node === "string") {
    out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      strings(v, `${path}.${k}`, out);
    }
  }
}

/** The path and a window around the match, so a failure names the string. */
function offenders(node: unknown, root: string): string[] {
  const all: Array<[string, string]> = [];
  strings(node, root, all);
  return all
    .filter(([, s]) => INTERNAL_CITATION.test(s))
    .map(([path, s]) => {
      const at = s.search(INTERNAL_CITATION);
      return `${path}: …${s.slice(Math.max(0, at - 60), at + 60).replace(/\n/g, " ")}…`;
    });
}

describe("the served contract carries no internal citations", () => {
  it("the OpenAPI document cites nothing that does not ship", () => {
    const doc = buildOpenApiDocument();
    expect(offenders(doc, "$")).toEqual([]);
    expect(INTERNAL_CITATION.test(JSON.stringify(doc))).toBe(false);
  });

  it("the error catalogue's served sentences cite nothing that does not ship", () => {
    expect(offenders(ERROR_CATALOGUE, "ERROR_CATALOGUE")).toEqual([]);
  });
});
