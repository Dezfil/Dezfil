import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { MapBuilder } from "@/components/builder/MapBuilder";
import { MapReader } from "@/components/reader/MapReader";
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
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function mapPage(account: string, id = "M") {
  who.account = account;
  return (await MapPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as ReactElement<Record<string, unknown>>;
}
async function workflowPage(account: string) {
  who.account = account;
  const page = (await WorkflowPage({ params: Promise.resolve({ id: "W" }) })) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
  return page.props.children;
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
    expect((page.props.children as ReactElement).type).toBe(MapBuilder);
  });

  it("gives a Viewer the builder on their own map filed in the project", async () => {
    const page = await mapPage("viv", "V");
    expect(page.type).toBe(LayerDownloadControlProvider);
  });

  it("leaves a map the reader cannot reach to the builder's own absent answer", async () => {
    const page = await mapPage("zed");
    expect(page.type).toBe(LayerDownloadControlProvider);
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
});
