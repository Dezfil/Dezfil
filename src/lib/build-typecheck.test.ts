import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import dockerIgnore from "@balena/dockerignore";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import packageJson from "../../package.json";

function readConfig(name: string) {
  const config = ts.getParsedCommandLineOfConfigFile(resolve(name), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!config) throw new Error(`Cannot read ${name}`);
  expect(config.errors).toEqual([]);
  return config;
}

const trackedFiles = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean));
const tracked = [...trackedFiles]
  .filter((file) => /\.tsx?$/.test(file));
const testFiles = tracked.filter((file) =>
  /\.(test|spec)\.tsx?$/.test(file) || /^(e2e|test-support|scripts\/perf)\//.test(file),
);
const full = readConfig("tsconfig.json");
const productionPath = nextConfig.typescript?.tsconfigPath ?? "tsconfig.json";
const production = readConfig(productionPath);

describe("container build typecheck scope", () => {
  it("excludes tests, browser support and perf sources from Next's effective config", () => {
    const included = new Set(production.fileNames);
    const leaked = testFiles.filter((file) => included.has(resolve(file)));
    expect(leaked.length, leaked.slice(0, 12).join("\n")).toBe(0);
    // The narrower check must still cover the application's TS and TSX sources.
    const appFiles = tracked.filter((file) =>
      file.startsWith("src/") && !/\.test\.tsx?$/.test(file),
    );
    expect(appFiles.length).toBeGreaterThan(0);
    expect(appFiles.filter((file) => !included.has(resolve(file)))).toEqual([]);
  });

  it("keeps every checked-in test in the full npm typecheck config", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(testFiles.some((file) => file.endsWith(".test.tsx"))).toBe(true);
    expect(testFiles.some((file) => file.startsWith("e2e/"))).toBe(true);
    expect(testFiles.some((file) => file.startsWith("test-support/"))).toBe(true);
    expect(testFiles.some((file) => file.startsWith("scripts/perf/"))).toBe(true);
    const included = new Set(full.fileNames);
    expect(testFiles.filter((file) => !included.has(resolve(file)))).toEqual([]);
  });

  it("keeps the production program's resolved imports inside the Docker context", () => {
    const root = resolve(".");
    const repoPath = (file: string) => relative(root, file).split(sep).join("/");
    const ignored = dockerIgnore({ ignorecase: false })
      .add(readFileSync(resolve(".dockerignore"), "utf8"));
    const cache = ts.createModuleResolutionCache(root,
      (file) => ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(),
      production.options);
    const pending = [...production.fileNames];
    const visited = new Set<string>();
    const leaked = new Set<string>();
    let resolvedSourceImports = 0;

    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = ts.sys.readFile(file);
      expect(source, `Cannot read ${repoPath(file)}`).toBeDefined();
      const imports = ts.preProcessFile(source!, true, true).importedFiles;
      for (const imported of imports) {
        const result = ts.resolveModuleName(imported.fileName, file,
          production.options, ts.sys, cache).resolvedModule;
        if (!result) continue; // The full typecheck holds unresolved imports.
        const target = resolve(result.resolvedFileName);
        const path = repoPath(target);
        if (path.split("/").includes("node_modules")) continue;
        resolvedSourceImports++;
        // Next creates these declarations inside the builder before typechecking.
        // Only next-env and Next's generated validator may import them here.
        const generatedImporter = repoPath(file) === "next-env.d.ts" ||
          /^\.next\/(dev\/)?types\/validator\.ts$/.test(repoPath(file));
        const generated = generatedImporter &&
          /^\.next\/(dev\/)?types\/(routes|root-params)\.d\.ts$/.test(path);
        const outside = path.startsWith("../") || isAbsolute(path);
        if (outside || (!generated && (!trackedFiles.has(path) || ignored.ignores(path)))) {
          leaked.add(`${repoPath(file)} -> ${imported.fileName} -> ${path}`);
        }
        if (!outside) pending.push(target);
      }
    }

    expect(resolvedSourceImports).toBeGreaterThan(0);
    expect([...leaked].sort(), "Resolved source imports outside the clean-checkout Docker context").toEqual([]);
  });

  it("inherits the full compiler settings and exclusions instead of duplicating them", () => {
    expect(production.raw.extends).toBe("./tsconfig.json");
    const ownConfig = ts.readConfigFile(resolve(productionPath), ts.sys.readFile);
    expect(ownConfig.error).toBeUndefined();
    expect(ownConfig.config.compilerOptions ?? {}).toEqual({});
    expect(production.raw.include).toEqual(full.raw.include);
    expect(production.raw.exclude).toEqual(expect.arrayContaining(full.raw.exclude));
  });
});
