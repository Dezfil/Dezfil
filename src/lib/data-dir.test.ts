import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import { ensureDataDir } from "./data-dir";

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  cleanups.push(dir);
  return dir;
}

describe("ensureDataDir", () => {
  it("creates a missing directory, including parents", async () => {
    const root = await tempRoot();
    const target = path.join(root, "nested", "data");
    await ensureDataDir(target);
    await expect(readdir(target)).resolves.toEqual([]);
  });

  it("passes on an existing writable directory and leaves no probe behind", async () => {
    const root = await tempRoot();
    await ensureDataDir(root);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("rejects a read-only directory with an actionable message", async () => {
    const root = await tempRoot();
    await chmod(root, 0o555);
    await expect(ensureDataDir(root)).rejects.toThrow(/not writable/);
  });
});
