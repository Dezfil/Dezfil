import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Exercise the journey's actual wait expressions with a response whose body
// becomes unavailable at a simulated reload. This does not launch a browser.
const source = ts.createSourceFile("account-deletion.spec.ts", readFileSync("e2e/account-deletion.spec.ts", "utf8"), ts.ScriptTarget.Latest, true);
const waits: { name: string; code: string; method: string; pathname: string }[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && ["accepted", "finishing"].includes(node.name.text)) {
    const finishing = node.name.text === "finishing";
    waits.push({
      name: `${node.name.text}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
      code: ts.transpileModule(`(${node.initializer.getText(source)})${finishing ? "()" : ""}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      method: finishing ? "POST" : "DELETE", pathname: finishing ? "/api/users/deletions/deletion/finish" : "/api/users/target",
    });
    return;
  }
  ts.forEachChild(node, visit);
}
visit(source);

it("covers all three acceptance waits and the continuation wait", () => { expect(waits).toHaveLength(4); });
for (const httpStatus of [200, 202]) it.each(waits)(`$name captures HTTP ${httpStatus} JSON as it arrives, before a simulated reload`, async ({ code, method, pathname }) => {
  const arriving = Promise.withResolvers<object>(), body = { id: "deletion", state: httpStatus === 200 ? "completed" : "pending" };
  let available = true;
  const response = {
    url: () => `http://instance.test${pathname}`, request: () => ({ method: () => method }), status: () => httpStatus,
    json: vi.fn(async () => {
      if (!available) throw new Error("No data found for resource");
      return body;
    }),
  };
  const waitForResponse = vi.fn((matches: (value: typeof response) => boolean) => {
    expect(matches(response)).toBe(true);
    expect(matches({ ...response, url: () => "http://instance.test/api/users/unrelated" })).toBe(false);
    expect(matches({ ...response, request: () => ({ method: () => "GET" }) })).toBe(false);
    return arriving.promise;
  });
  const captured = runInNewContext(code, { page: { waitForResponse }, URL, expect, target: { id: "target" }, empty: { id: "target" }, status: { id: "deletion" } });
  expect(waitForResponse).toHaveBeenCalledTimes(1);
  arriving.resolve(response);
  await new Promise(resolve => setImmediate(resolve));
  available = false;
  expect(response.json).toHaveBeenCalledTimes(1);
  expect(await captured).toEqual(body);
});
