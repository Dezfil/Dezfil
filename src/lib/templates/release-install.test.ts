import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildTemplate, SEEDS, type BuiltTemplate } from "../../../test-support/templates/builder";
import { startLoopbackCatalogue } from "../../../test-support/templates/catalogue";
import { readInstalledVersion } from "./installed";
import { readShippedIndex } from "./shipped";
import { resetQueryInstance } from "@/lib/duckdb";

const execute = promisify(execFile);
let root: string, good: BuiltTemplate, newer: BuiltTemplate, bad: BuiltTemplate;
beforeAll(async () => {
  root = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "release-"));
  good = await buildTemplate(path.join(root, "good"));
  newer = await buildTemplate(path.join(root, "newer"), { id: good.facts.id, version: 2, kind: "workflow" });
  bad = await buildTemplate(path.join(root, "bad"), { version: 2, edit: SEEDS.layerReferenceOutside });
});
afterAll(async () => { resetQueryInstance(); await rm(root, { recursive: true, force: true }); });

async function install(template: BuiltTemplate, target: string, source = template.archive, sha256 = template.sha256, options: string[] = []) {
  try {
    const result = await execute(process.execPath, ["scripts/install-template.mjs", source,
      "--sha256", sha256, "--size", String(template.size), "--target", target, ...options], {
      cwd: process.cwd(), timeout: 20_000,
      env: { ...process.env, DEZFIL_EGRESS_ALLOWLIST: "localhost,127.0.0.1" },
    });
    return { ...result, ok: true };
  } catch (error) {
    const result = error as { stdout: string; stderr: string };
    return { ...result, ok: false };
  }
}

it("installs a local release with the shipped layout and refuses a repeated version unchanged", async () => {
  const target = path.join(root, "installed");
  const first = await install(good, target);
  expect(first.ok, first.stderr).toBe(true);
  expect(first.stdout).toContain(`${good.facts.id} version ${good.facts.version}`);
  expect(await readShippedIndex(target)).toEqual({ formatVersion: 1, templates: [{ id: good.facts.id, version: good.facts.version }] });
  const folder = path.join(target, good.facts.id, String(good.facts.version));
  const installed = await readInstalledVersion(folder);
  expect(installed.record.origin).toEqual({ kind: "shipped" });
  expect(installed.record.archive).toEqual({ sha256: good.sha256, size: good.size });
  const before = await readFile(path.join(target, "index.json"));
  const second = await install(good, target);
  expect(second.ok).toBe(false);
  expect(second.stderr).toContain("already shipped");
  expect(await readFile(path.join(target, "index.json"))).toEqual(before);
  expect((await readInstalledVersion(folder)).record).toEqual(installed.record);
});

it("refuses a product-invalid archive and a checksum mismatch without creating a target", async () => {
  for (const [template, checksum, code] of [[bad, bad.sha256, "template_reference_outside"], [good, "0".repeat(64), "template_checksum_mismatch"]] as const) {
    const target = path.join(root, code);
    const result = await install(template, target, template.archive, checksum);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(code);
    expect(existsSync(target)).toBe(false);
  }
  expect((await readdir(root)).filter(name => name.includes("install-") || name.endsWith(".lock"))).toEqual([]);
});

it("downloads a loopback release with the fixed public identity and no account credentials", async () => {
  const catalogue = await startLoopbackCatalogue();
  try {
    const index = await catalogue.publish([good], { releaseStyle: true });
    const url = new URL(index.templates[0].archive, catalogue.indexUrl).href;
    const target = path.join(root, "from-url");
    const result = await install(good, target, url);
    expect(result.ok, result.stderr).toBe(true);
    expect(catalogue.requests.length).toBeGreaterThan(0);
    for (const request of catalogue.requests) {
      expect(request.headers["user-agent"]).toBe("Dezfil-templates/1.0 (+https://dezfil.io)");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.from).toBeUndefined();
    }
    expect((await readShippedIndex(target)).templates).toHaveLength(1);
  } finally { await catalogue.close(); }
});

it("leaves an existing shipped set unchanged when a new archive is refused", async () => {
  const target = path.join(root, "existing");
  const first = await install(good, target);
  expect(first.ok, first.stderr).toBe(true);
  const before = await readFile(path.join(target, "index.json"));
  const result = await install(bad, target);
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("template_reference_outside");
  expect(await readFile(path.join(target, "index.json"))).toEqual(before);
  expect((await readInstalledVersion(path.join(target, good.facts.id, "1"))).record.archive.sha256).toBe(good.sha256);
  expect(existsSync(path.join(target, good.facts.id, "2"))).toBe(false);
});

it("replaces a shipped version with the complete newer workflow and removes the old folder", async () => {
  const target = path.join(root, "upgrade");
  const first = await install(good, target);
  expect(first.ok, first.stderr).toBe(true);
  const second = await install(newer, target);
  expect(second.ok, second.stderr).toBe(true);
  expect(await readShippedIndex(target)).toEqual({ formatVersion: 1, templates: [{ id: good.facts.id, version: 2 }] });
  expect(existsSync(path.join(target, good.facts.id, "1"))).toBe(false);
  expect((await readInstalledVersion(path.join(target, good.facts.id, "2"))).admitted.workflow).not.toBeNull();
});

it("refuses a linked target without changing the folder it points to", async () => {
  const original = path.join(root, "link-source"), target = path.join(root, "linked");
  const first = await install(good, original);
  expect(first.ok, first.stderr).toBe(true);
  await symlink(original, target, "dir");
  const before = await readFile(path.join(original, "index.json"));
  const result = await install(newer, target);
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("symbolic links");
  expect(await readFile(path.join(original, "index.json"))).toEqual(before);
  expect((await readInstalledVersion(path.join(original, good.facts.id, "1"))).record.archive.sha256).toBe(good.sha256);
});

async function shippedFiles(target: string) {
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.relative(target, path.join(entry.parentPath, entry.name))).sort();
  return Promise.all(files.map(async file => [file, (await readFile(path.join(target, file))).toString("base64")]));
}

it("refuses an older release with both versions and leaves every shipped file unchanged", async () => {
  const target = path.join(root, "no-downgrade");
  const first = await install(newer, target);
  expect(first.ok, first.stderr).toBe(true);
  const before = await shippedFiles(target);
  const result = await install(good, target);
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain(`${good.facts.id} version 1 is older than shipped version 2`);
  expect(result.stderr).toContain("--allow-downgrade");
  expect(await shippedFiles(target)).toEqual(before);
  expect((await readdir(root)).filter(name => name.includes("install-") || name.endsWith(".lock"))).toEqual([]);
});

it("allows an explicit downgrade while still refusing the same immutable version", async () => {
  const target = path.join(root, "explicit-downgrade");
  const first = await install(newer, target);
  expect(first.ok, first.stderr).toBe(true);
  const result = await install(good, target, good.archive, good.sha256, ["--allow-downgrade"]);
  expect(result.ok, result.stderr).toBe(true);
  expect(result.stdout).toContain(`${good.facts.id} version 1`);
  expect(await readShippedIndex(target)).toEqual({ formatVersion: 1, templates: [{ id: good.facts.id, version: 1 }] });
  expect((await readInstalledVersion(path.join(target, good.facts.id, "1"))).record.archive.sha256).toBe(good.sha256);
  expect(existsSync(path.join(target, good.facts.id, "2"))).toBe(false);
  const before = await shippedFiles(target);
  const repeated = await install(good, target, good.archive, good.sha256, ["--allow-downgrade"]);
  expect(repeated.ok).toBe(false);
  expect(repeated.stderr).toContain("already shipped");
  expect(await shippedFiles(target)).toEqual(before);
});

it("names an occupied lock without removing it or writing a target", async () => {
  const target = path.join(root, "locked");
  const lock = target + ".lock";
  await mkdir(lock);
  try {
    const result = await install(good, target);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(`Another template install owns the target lock: ${lock}`);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(target)).toBe(false);
  } finally { await rm(lock, { recursive: true }); }
});
