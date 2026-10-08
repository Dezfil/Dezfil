import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { MapBuilder } from "@/components/builder/MapBuilder";
import { MapReader } from "@/components/reader/MapReader";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { WorkflowScreen } from "@/components/WorkflowScreen";
import MapPage from "./maps/[id]/page";
import WorkflowPage from "./workflows/[id]/page";

/**
 * The page decides the presentation once, from the reader's standing on
 * the map or workflow as the reach kernel holds it: a Viewer gets the
 * reader (a map) or the view-only canvas (a workflow), an Editor, the
 * project's owner and the resource's owner the shipped builder and canvas.
 * Nothing in the browser can switch a Viewer's page into an editor.
 *
 * Pat owns project P, where Edd is an editor and Viv a viewer; Pat's map M
 * and workflow W are filed in P, and Viv's own map V is filed there too.
 */

vi.mock("@/components/builder/MapBuilder", () => ({ MapBuilder: () => null }));
vi.mock("@/components/reader/MapReader", () => ({ MapReader: () => null }));
vi.mock("@/components/WorkflowScreen", () => ({ WorkflowScreen: () => null }));
const who = vi.hoisted(() => ({ account: "pat", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () =>
    testAccountRequest(new Request("http://instance.test/maps/M"), who.db as Database, who.account).headers,
}));

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["pat", "edd", "viv", "zed"]) testAccountScope(db, id);
  const at = "2026-01-01T00:00:00.000Z";
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${at}', '${at}', 'pat');
    INSERT INTO project_people VALUES ('P', 'edd', 'editor', '${at}'), ('P', 'viv', 'viewer', '${at}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES
      ('M', 'Station catchments', '${at}', '${at}', 'pat', 'P'), ('V', 'Viv map', '${at}', '${at}', 'viv', 'P');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id)
      VALUES ('W', 'Permit geocoding', 'workflow', '${at}', '${at}', 'pat', 'P');`);
  // Fay's map F and workflow G are filed in P too; Fay is a member, then
  // deactivated, so what she owns is frozen.
  testAccountScope(db, "fay");
  db.exec(`INSERT INTO project_people VALUES ('P', 'fay', 'editor', '${at}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('F', 'Fay map', '${at}', '${at}', 'fay', 'P');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id)
      VALUES ('G', 'Fay workflow', 'workflow', '${at}', '${at}', 'fay', 'P');
    UPDATE accounts SET status = 'deactivated' WHERE id = 'fay';`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function mapPage(account: string, id = "M") {
  who.account = account;
  return (await MapPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as ReactElement<Record<string, unknown>>;
}
/** The screen a page opens, inside the providers around it. */
function screenOf(page: ReactElement<Record<string, unknown>>): ReactElement<Record<string, unknown>> {
  const provider = page.props.children as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
  expect(provider.type).toBe(ScreenDefaultsProvider);
  return provider.props.children;
}
async function workflowPage(account: string, id = "W") {
  who.account = account;
  return screenOf((await WorkflowPage({ params: Promise.resolve({ id }) })) as ReactElement<Record<string, unknown>>);
}

describe("a map's page", () => {
  it("gives a Viewer the reader", async () => {
    const page = await mapPage("viv");
    expect(page.type).toBe(MapReader);
    expect(page.props.mapId).toBe("M");
  });

  it.each(["pat", "edd"])("gives %s the builder", async (account) => {
    const page = await mapPage(account);
    expect(page.type).toBe(LayerDownloadControlProvider);
    expect(screenOf(page).type).toBe(MapBuilder);
  });

  it("gives a Viewer the builder on their own map filed in the project", async () => {
    const page = await mapPage("viv", "V");
    expect(page.type).toBe(LayerDownloadControlProvider);
  });

  it("refuses a map the reader cannot reach on the server", async () => {
    await expect(mapPage("zed")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
  it("refuses deleting owners on the page while independent ownership stays readable", async () => {
    db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'fay'");
    await expect(mapPage("viv", "F")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(workflowPage("viv", "G")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect((await mapPage("viv", "V")).type).toBe(LayerDownloadControlProvider);
  });

  // A map whose owner is deactivated is read-only for everyone: an Editor
  // and the project's owner read it rather than get a builder whose every
  // save is refused.
  it.each(["edd", "pat", "viv"])("gives %s the reader on a frozen map", async (account) => {
    const page = await mapPage(account, "F");
    expect(page.type).toBe(MapReader);
  });
});

describe("a workflow's page", () => {
  it("gives a Viewer the view-only canvas", async () => {
    const screen = await workflowPage("viv");
    expect(screen.type).toBe(WorkflowScreen);
    expect(screen.props.viewOnly).toBe(true);
  });

  it.each(["pat", "edd"])("gives %s the shipped canvas", async (account) => {
    const screen = await workflowPage(account);
    expect(screen.type).toBe(WorkflowScreen);
    expect(screen.props.viewOnly).toBe(false);
  });

  it("keeps runs off a Viewer's canvas and on an Editor's", async () => {
    expect((await workflowPage("viv")).props.runs).toBe(false);
    expect((await workflowPage("edd")).props.runs).toBe(true);
  });

  // A frozen workflow's contents are read-only for everyone, but it still
  // runs for whoever may run it.
  it.each([["edd", true], ["pat", true], ["viv", false]] as const)(
    "gives %s the view-only canvas on a frozen workflow, runs %s",
    async (account, runs) => {
      const screen = await workflowPage(account, "G");
      expect(screen.props.viewOnly).toBe(true);
      expect(screen.props.runs).toBe(runs);
    },
  );
});
