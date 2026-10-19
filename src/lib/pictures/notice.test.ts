import type { Database } from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as readSettings } from "@/app/api/instance/settings/route";
import * as metadata from "@/lib/metadata/db";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { pictureRendererNotice } from "./notice";
import { pictureRendererFailed, retryPictureRenderer } from "./renderer";

/**
 * The line a card page shows about a missing renderer is an administrator's
 * alone, and it follows the System read: shown exactly while that read says
 * picture work cannot use the renderer (no program where the setting points,
 * or a launch refusal awaiting the next look), never to a member, and never
 * once the renderer stands.
 */

const SCRATCH = path.join(process.cwd(), ".claude/test-data");
let db: Database, dir: string;

beforeEach(() => {
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(path.join(SCRATCH, "picture-notice-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  testAccountScope(db, "member");
});
afterEach(() => {
  retryPictureRenderer();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What the System read says of picture work's renderer, read as the admin. */
async function systemSaysAvailable(): Promise<boolean> {
  const response = await readSettings(testAccountRequest(new Request("http://instance.test/api/instance/settings"), db, "admin"));
  expect(response.status).toBe(200);
  return (await response.json()).parts.image_renderer.available as boolean;
}

function browserProgram(): string {
  const file = path.join(dir, "browser");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

it.each([
  ["no program where the setting points", () => vi.stubEnv("DEZFIL_CHROMIUM_PATH", path.join(dir, "missing")), false],
  ["a program there", () => vi.stubEnv("DEZFIL_CHROMIUM_PATH", browserProgram()), true],
  ["a program there whose launch was refused", () => { vi.stubEnv("DEZFIL_CHROMIUM_PATH", browserProgram()); pictureRendererFailed(); }, false],
])("with %s, an administrator is told exactly when the System read says unavailable, a member never", async (_, arrange, available) => {
  arrange();
  expect(await systemSaysAvailable()).toBe(available);
  expect(pictureRendererNotice(testAccountScope(db, "admin"), db)).toBe(!available);
  expect(pictureRendererNotice(testAccountScope(db, "member"), db)).toBe(false);
});

it("is no longer shown once a refused renderer is looked at again and stands", async () => {
  vi.stubEnv("DEZFIL_CHROMIUM_PATH", browserProgram());
  pictureRendererFailed();
  expect(pictureRendererNotice(testAccountScope(db, "admin"), db)).toBe(true);
  retryPictureRenderer();
  expect(await systemSaysAvailable()).toBe(true);
  expect(pictureRendererNotice(testAccountScope(db, "admin"), db)).toBe(false);
});
