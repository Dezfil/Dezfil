import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

/** Execute the inline browser setup functions themselves. The transport is
 * stubbed, so a dropped header is observable without launching a browser. */
const setups = readdirSync("e2e").filter(file => file.endsWith(".spec.ts")).flatMap(file => {
  const source = ts.createSourceFile(file, readFileSync(`e2e/${file}`, "utf8"), ts.ScriptTarget.Latest, true);
  const found: { name: string; code: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionExpression(node) && node.name?.text === "readThenWriteWorkflowSetup") {
      found.push({ name: `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`, code: ts.transpileModule(`(${node.getText(source)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
});

it.each(setups)("$name carries one read's revision into its write", async ({ code }) => {
  const calls: { path: string; headers: Headers; method: string }[] = [];
  const entity = { id: "w", recipe: { id: "w" }, step: { id: "s" }, steps: [{ id: "s" }], toString: () => "w" };
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    return Response.json({ editRevision: "captured", recipe: { editRevision: "captured" } });
  };
  await runInNewContext(code, { fetch, id: "w", big: "w", recipe: entity, step: entity, stepId: "s", table: "input", prev: "input", input: "input", name: "out", bad: "invalid", headers: { "Content-Type": "application/json" } });
  expect.soft(calls.at(-1)!.headers.get("X-Edit-Revision")).toBe("captured");
  expect(calls).toHaveLength(2);
  expect(calls[0].method).toBe("GET");
  expect(calls[1].method).not.toBe("GET");
  expect(calls[1].path.startsWith(`${calls[0].path}/`)).toBe(true);
  expect(calls[1].headers.get("X-Edit-Revision")).toBe("captured");
});
