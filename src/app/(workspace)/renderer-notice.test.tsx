import type { Database } from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { MapsScreen } from "@/components/MapsScreen";
import { ProjectsScreen } from "@/components/ProjectsScreen";
import { HomeScreen } from "@/components/home/HomeScreen";
import { ProjectHomeScreen } from "@/components/projects/ProjectHomeScreen";
import HomePage from "./page";
import MapsPage from "./maps/page";
import ProjectsPage from "./projects/page";
import ProjectPage from "./projects/[id]/page";

/**
 * Every page of map cards is handed, as it is served, whether its reader
 * is an administrator to be told the pictures have no renderer: Home, the
 * Maps page, the Projects page and a project's home, for an administrator
 * exactly while there is none, and never for a member, with or without one.
 */

const who = vi.hoisted(() => ({ account: "ada", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () => testAccountRequest(new Request("http://instance.test/"), who.db as Database, who.account).headers,
}));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  notFound: () => { throw new Error("not found"); },
}));

const SCRATCH = path.join(process.cwd(), ".claude/test-data");
let db: Database, dir: string;
beforeEach(() => {
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(path.join(SCRATCH, "renderer-notice-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["ada", "bo"]) testAccountScope(db, id);
  const at = "2026-10-01T09:00:00.000Z";
  db.exec(`UPDATE accounts SET is_admin = 1 WHERE id = 'ada';
    INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${at}', '${at}', 'ada');
    INSERT INTO project_people VALUES ('P', 'bo', 'editor', '${at}');`);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every element of a tree as built, without rendering it. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
}

const PAGES: [string, () => Promise<ReactNode>, unknown][] = [
  ["Home", () => HomePage(), HomeScreen],
  ["the Maps page", () => MapsPage(), MapsScreen],
  ["the Projects page", () => ProjectsPage(), ProjectsScreen],
  ["a project's home", () => ProjectPage({ params: Promise.resolve({ id: "P" }) }), ProjectHomeScreen],
];

/** The flag the page hands its screen, as `account` is served it. */
async function handed(page: () => Promise<ReactNode>, screen: unknown, account: string): Promise<unknown> {
  who.account = account;
  const found = elements(await page()).filter((element) => element.type === screen);
  expect(found).toHaveLength(1);
  return (found[0].props as { rendererNotice?: unknown }).rendererNotice;
}

function renderer(present: boolean) {
  const file = path.join(dir, "browser");
  if (present) writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  vi.stubEnv("DEZFIL_CHROMIUM_PATH", file);
}

it.each(PAGES)("%s tells an administrator, and only one, while there is no renderer", async (_, page, screen) => {
  renderer(false);
  expect(await handed(page, screen, "ada")).toBe(true);
  expect(await handed(page, screen, "bo")).toBe(false);
  renderer(true);
  expect(await handed(page, screen, "ada")).toBe(false);
  expect(await handed(page, screen, "bo")).toBe(false);
});
