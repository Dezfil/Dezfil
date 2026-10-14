import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ResultGrid } from "./ResultGrid";
import type { QueryResult } from "./query-types";

const result = (preview: Record<string, unknown>[]): QueryResult => ({
  columns: [{ name: "__proto__", type: "VARCHAR" }, { name: "constructor", type: "VARCHAR" }],
  rowCount: preview.length, preview, previewTruncated: false, runtimeMs: 3,
});

it("a column named __proto__ or constructor shows the row's own value, and a row without one shows the empty glyph, never what the prototype carries", () => {
  // Rows arrive as parsed JSON, which keeps either name as an own key.
  const own = renderToStaticMarkup(<ResultGrid result={result([JSON.parse('{"__proto__":"north","constructor":"Ada"}')])} />);
  expect(own).toContain('title="north"');
  expect(own).toContain(">north<");
  expect(own).toContain(">Ada<");
  const missing = renderToStaticMarkup(<ResultGrid result={result([{}])} />);
  expect(missing.match(/∅/g)).toHaveLength(2);
  expect(missing).not.toContain("[object Object]");
  expect(missing).not.toContain("function Object");
});
