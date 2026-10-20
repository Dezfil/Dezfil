import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { HTTP_METHODS } from "@/lib/api/http-methods";
import { buildTools } from "@/lib/tools/tools";
import { limitsSettingRows } from "@/components/settings/limits-table";

/**
 * The admin's operations on this instance, every one under
 * /api/instance, are each described in the API guide by method and path
 * and in the MCP guide by the tool it generates, so a new one cannot ship
 * with no reader-facing word.
 */

const api = readFileSync("docs/api/http-api.md", "utf8");
const mcp = readFileSync("docs/api/mcp.md", "utf8");

/** A count from twenty to ninety-nine, in the guides' words. */
function inWords(count: number): string {
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"][Math.floor(count / 10)];
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][count % 10];
  return ones ? `${tens}-${ones}` : tens;
}

describe("the instance operations in the guides", () => {
  const document = buildOpenApiDocument();
  const operations = Object.entries(document.paths).filter(([path]) => path.startsWith("/api/instance/"))
    .flatMap(([path, item]) => Object.entries(item as Record<string, { "x-tool"?: boolean }>)
      .filter(([method, operation]) => HTTP_METHODS.has(method) && operation["x-tool"] !== false)
      .map(([method]) => ({ call: `${method.toUpperCase()} ${path}`, method, path })));
  const tools = buildTools();

  it("covers the settings, the services, the parts, the storage and the basemap library", () => {
    expect(operations.map(operation => operation.call).sort()).toEqual([
      "DELETE /api/instance/basemaps/{id}", "DELETE /api/instance/caches", "GET /api/instance/settings", "GET /api/instance/storage",
      "PATCH /api/instance/basemaps/{id}", "PATCH /api/instance/settings", "POST /api/instance/basemaps",
      "POST /api/instance/parts/{part}/test", "POST /api/instance/services/{service}/test",
    ]);
  });

  it("names how many keys the settings change takes in both guides, and in the API guide every one the Limits tab does not draw", () => {
    const keys = Object.keys(document.components.schemas.InstanceSettingsPatch.properties);
    const flat = (text: string) => text.replace(/\s+/g, " ");
    expect(flat(api)).toContain(`changes only submitted editable keys, ${inWords(keys.length)} of them`);
    expect(flat(mcp)).toContain(`editable-key input, ${inWords(keys.length)} keys`);
    const limits = new Set(limitsSettingRows().map(row => row.key));
    expect(keys.filter(key => !limits.has(key) && !api.includes(`\`${key}\``))).toEqual([]);
  });

  it.each(["GET /api/instance/settings", "PATCH /api/instance/settings", "POST /api/instance/services/{service}/test",
    "DELETE /api/instance/caches", "POST /api/instance/parts/{part}/test", "GET /api/instance/storage",
    "POST /api/instance/basemaps", "PATCH /api/instance/basemaps/{id}", "DELETE /api/instance/basemaps/{id}"])("describes %s in both guides", call => {
    expect(api, call).toContain(`\`${call}\``);
    const operation = operations.find(found => found.call === call)!;
    const tool = tools.find(found => found.method === operation.method && found.path === operation.path);
    expect(tool, call).toBeDefined();
    expect(mcp, tool!.name).toContain(`\`${tool!.name}\``);
  });
});
