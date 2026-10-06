import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const execute = promisify(execFile);
let bundle: string;

// Compile just this boundary into an isolated Node process. The listener in
// the child sees unowned rejections without Vitest's global handler. Only
// downstream ingestion/metadata and authenticated scope are supplied as fixtures;
// receiver, ownership ledger and HTTP mapper are real.
beforeAll(async () => {
  bundle = await mkdtemp(path.join(process.cwd(), ".tmp-upload-"));
  const files = [
    "src/lib/ingest/receive.ts", "src/lib/ingest/budget.ts", "src/lib/ingest/file-ownership.ts", "src/lib/config.ts", "src/lib/limits.ts",
    "src/lib/settings/resolver.ts", "src/lib/settings/catalogue.ts", "src/lib/settings/numeric.ts", "src/lib/settings/types.ts", "src/lib/settings/state.ts",
    "src/lib/api/errors.ts", "src/lib/api/error-catalogue.ts", "src/lib/auth/errors.ts",
    "src/lib/project-scope.ts", "src/app/api/tables/route.ts",
  ];
  const mocks = new Map([
    // This fixture isolates receiver lifetime; the gate has its own real-route inventory.
    ["src/lib/auth/route-gate.ts", "exports.withRouteGate = (_request, work) => work();"],
    // No account work is admitted in this receiver fixture. Still run and await
    // the real ownership cleanup; deletion-lease retention is proven separately.
    ["src/lib/auth/account-deletion-work.ts", "exports.observeDeletionCleanup = (cleanup) => cleanup();"],
    ["src/lib/ingest/gdal-formats.ts", `
      const fs = require("node:fs/promises");
      exports.calls = [];
      exports.ingestSource = async (_scope, target, filename) => {
        exports.calls.push({ filename, bytes: await fs.readFile(target, "utf8") });
        return { tables: [{ id: "fixture-table", name: filename }] };
      };
      exports.toIngestResponse = (result) => result;
    `],
    ["src/lib/auth/scope-http.ts", "exports.requireRequestScope = () => ({ accountId: 'upload-fixture' });"],
    ["src/lib/auth/reach.ts", "exports.requireFilingDestination = () => { throw new Error('unexpected project lookup'); };"],
    ["src/lib/table-service.ts", "exports.listTablesWithSize = () => [];"],
  ]);
  const output = (file: string) => path.join(bundle, file.replace(/\.ts$/, ".cjs"));
  for (const [file, contents] of mocks) {
    await mkdir(path.dirname(output(file)), { recursive: true });
    await writeFile(output(file), contents);
  }
  for (const file of files) {
    const source = (await readFile(file, "utf8")).replace(/from "([^"]+)"/g, (match, specifier: string) => {
      const dependency = specifier.startsWith("@/") ? `src/${specifier.slice(2)}.ts`
        : specifier.startsWith(".") ? path.join(path.dirname(file), `${specifier}.ts`) : null;
      if (!dependency) return match;
      if (!files.includes(dependency) && !mocks.has(dependency)) {
        throw new Error(`Unaccounted upload dependency: ${dependency}`);
      }
      return `from ${JSON.stringify(output(dependency))}`;
    });
    await mkdir(path.dirname(output(file)), { recursive: true });
    await writeFile(output(file), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText);
  }
});
afterAll(async () => { await rm(bundle, { recursive: true, force: true }); });

async function run(mode: string, boundary: "receiver" | "route") {
  const { stdout } = await execute(process.execPath, [
    "src/lib/ingest/fixtures/receive-lifetime.mjs", bundle, mode, boundary,
  ], { timeout: 8_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (process.env.DEZFIL_STREAM_EVIDENCE === "1") {
    const evidence = { ...result };
    delete evidence.bytes;
    delete evidence.body;
    console.info(JSON.stringify({ boundary, mode, ...evidence }));
  }
  return result;
}

for (const boundary of ["receiver", "route"] as const) {
  describe(`owned upload streams via ${boundary}`, () => {
    it.each([
      ["truncated", 400, "invalid_request"],
      ["missing-boundary", 400, "invalid_request"],
      ["malformed-header", 400, "invalid_request"],
      ["source-error", 400, "invalid_request"],
      ["source-error-delayed-close", 400, "invalid_request"],
      ["abort", 499, null],
      ["abort-delayed-close", 499, null],
      ["abort-delayed-cancel", 499, null],
      ["abort-and-source-error", 499, null],
      ["source-error-then-abort-delayed-close", 499, null],
      ["write-error", 500, "internal"],
      ["flush-error", 500, "internal"],
      ["size-limit", 413, "upload_too_large"],
      ["size-limit-at-closing-boundary", 413, "upload_too_large"],
      ["wrong-field", 400, "invalid_request"],
      ["node-size-limit", 413, "upload_too_large"],
      ["node-wrong-field", 400, "invalid_request"],
      ["multiple-files", 400, "invalid_request"],
    ])("settles %s without residue, ingest or global rejection", async (mode, status, code) => {
      const result = await run(mode as string, boundary);
      expect.soft(result.timedOut).toBe(false);
      expect.soft(result.status).toBe(status);
      expect.soft(result.code).toBe(code);
      if (status === 499) expect.soft(result.body).toBe("");
      if (mode === "missing-boundary") expect.soft(result.message).toBe("The multipart upload is missing its boundary parameter.");
      if (status === 500) expect.soft(result.message).toBe("The upload could not be written to storage.");
      if (["truncated", "malformed-header", "source-error", "source-error-delayed-close"].includes(mode as string)) {
        expect.soft(result.message).toMatch(/upload.*(interrupted|incomplete|multipart)/i);
      }
      expect.soft(result.ingestsAtSettlement).toBe(0);
      expect.soft(result.filesAtSettlement).toEqual([]);
      expect.soft(result.filesAfterLateWork).toEqual([]);
      expect.soft(result.ownedFilesAtSettlement).toEqual([]);
      expect.soft(result.ownedFilesAfterLateWork).toEqual([]);
      expect.soft(result.globalRejections).toEqual([]);
      expect.soft(result.sourceSettled).toBe(true);
      expect.soft(result.parserClosedAtSettlement).toBe(true);
      expect.soft(result.destinationClosedAtSettlement).toBe(true);
      if (["truncated", "source-error", "source-error-delayed-close", "abort", "abort-delayed-close", "abort-delayed-cancel", "abort-and-source-error", "source-error-then-abort-delayed-close", "write-error"].includes(mode as string)) {
        expect.soft(result.partialBytes).toBeGreaterThan(0);
      }
      if ((mode as string).startsWith("node-")) {
        expect.soft(result.chunksAtSettlement).toBeLessThan(result.totalChunks);
        expect.soft(result.chunksProduced).toBeGreaterThan(0);
      }
      if (["missing-boundary", "malformed-header"].includes(mode as string)) expect.soft(result.destinationsCreated).toBe(0);
      if (mode === "write-error") expect.soft(result.secondaryCancellation).toBe(true);
      expect.soft(result.recovery).toEqual({ status: 201, filename: "recovered.csv", bytes: "x,y\n1,2\n" });
    }, 10_000);

    it.each(["success", "delayed-success"])("retains complete bytes, filename and success for %s", async (mode) => {
      const result = await run(mode, boundary);
      expect.soft(result.timedOut).toBe(false);
      expect.soft(result.status).toBe(201);
      expect.soft(result.filename).toBe("points.csv");
      expect.soft(result.bytes).toBe("x,y\n" + "1,2\n".repeat(2048));
      expect.soft(result.ownedFilesAtSettlement).toEqual([]);
      expect.soft(result.ownedFilesAfterLateWork).toEqual([]);
      expect.soft(result.destinationClosedAtSettlement).toBe(true);
      expect.soft(result.globalRejections).toEqual([]);
      expect.soft(result.sourceSettled).toBe(true);
      expect.soft(result.parserClosedAtSettlement).toBe(true);
    }, 10_000);
  });
}
