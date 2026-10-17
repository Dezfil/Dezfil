import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { gateRequest } from "./gate";
import { NO_PAGE, pageFindsNothing, withPagePresence } from "./page-presence";
import type { AccountScope } from "./scope";

/**
 * Ada owns map M, workflow W, project P and dataset D ("roads"); M is filed
 * in P, where Vi is a Viewer. Bo belongs to nothing. A page that shows one
 * resource finds nothing for whoever does not reach it, exactly as the API
 * answers that person; reaching through a project counts as reaching. A
 * template is every account's: only one the catalogue does not list is
 * missing.
 */

vi.mock("@/lib/templates/catalogue", async () => {
  const { ApiError } = await import("@/lib/api/errors");
  return {
    readTemplateForAddress: async (id: string) => {
      if (id === "listed") return { id };
      if (id === "unreadable") throw new Error("The catalogue could not be read.");
      throw new ApiError("template_not_listed", "No template with that id is shipped, downloaded or listed by the catalogue.", 404);
    },
  };
});

let db: Database;
let ada: AccountScope, vi_: AccountScope, bo: AccountScope;
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  [ada, vi_, bo] = ["ada", "vi", "bo"].map(id => testAccountScope(db, id));
  db.exec(`INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES ('P', 'Survey', '${now}', '${now}', 'ada');
    INSERT INTO project_people VALUES ('P', 'vi', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('M', 'Harbour', '${now}', '${now}', 'ada', 'P');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id) VALUES ('W', 'Staging', 'workflow', '${now}', '${now}', 'ada', NULL);
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('D', 'roads', 'geoparquet', 'tables/d.parquet', 1, '${now}', 'ada');`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const PAGES = ["/maps/M", "/workflows/W", "/projects/P", "/tables/D", "/tables/roads", "/templates/listed"];

describe("what a page that shows one resource finds", () => {
  it("finds every page for the owner, and a listed template for anyone", async () => {
    for (const page of PAGES) expect(await pageFindsNothing(ada, page), page).toBe(false);
    expect(await pageFindsNothing(bo, "/templates/listed")).toBe(false);
  });

  it("finds nothing behind someone else's resource, exactly as behind a missing one", async () => {
    for (const page of PAGES.filter(page => !page.startsWith("/templates/"))) expect(await pageFindsNothing(bo, page), page).toBe(true);
    for (const page of ["/maps/none", "/workflows/none", "/projects/none", "/tables/none", "/tables/none/", "/templates/none"]) {
      expect(await pageFindsNothing(ada, page), page).toBe(true);
    }
  });

  it("counts reaching through a project, whatever the role", async () => {
    expect(await pageFindsNothing(vi_, "/maps/M")).toBe(false);
    expect(await pageFindsNothing(vi_, "/projects/P")).toBe(false);
    expect(await pageFindsNothing(vi_, "/workflows/W")).toBe(true);
  });

  it("judges only the pages that show one resource, and leaves a read that fails otherwise to the page", async () => {
    for (const page of ["/", "/maps", "/maps/none/more", "/data", "/settings/account", "/connections/none", "/maps/%E0%A4%A", "/templates/unreadable"]) {
      expect(await pageFindsNothing(bo, page), page).toBe(false);
    }
  });
});

describe("the gate's answer to a signed-in page request", () => {
  const served = async (pathname: string, who = "ada", method = "GET") => {
    const request = testAccountRequest(new Request(`http://instance.test${pathname}`, { method }), db, who);
    const gate = gateRequest(request);
    return { gate, answer: await withPagePresence(request, gate) };
  };
  const rewrittenTo = (response: Response) => {
    const target = response.headers.get("x-middleware-rewrite");
    return target === null ? null : new URL(target).pathname;
  };

  it("serves a page that finds nothing as the address no page answers, with the gate's cookie and privacy", async () => {
    for (const [pathname, who] of [["/maps/M", "bo"], ["/maps/none", "ada"], ["/projects/P", "bo"], ["/tables/roads", "bo"], ["/templates/none", "bo"]]) {
      const { gate, answer } = await served(pathname, who);
      expect(rewrittenTo(answer), `${who} ${pathname}`).toBe(NO_PAGE);
      expect(answer.headers.get("x-middleware-next"), pathname).toBeNull();
      expect(answer.headers.get("cache-control"), pathname).toBe("private, no-store");
      expect(gate.headers.getSetCookie().length, pathname).toBeGreaterThan(0);
      expect(answer.headers.getSetCookie(), pathname).toEqual(gate.headers.getSetCookie());
    }
  });

  it("passes the gate's own answer on for a page that finds its resource, any other address, and anything but a read", async () => {
    for (const [pathname, who, method] of [["/maps/M", "ada", "GET"], ["/maps/M", "vi", "HEAD"], ["/maps", "bo", "GET"], ["/api/maps/none", "ada", "GET"], ["/maps/none", "ada", "POST"]]) {
      const { gate, answer } = await served(pathname, who, method);
      expect(answer, `${method} ${pathname}`).toBe(gate);
    }
  });

  it("passes on the gate's answer to someone signed out", async () => {
    const signedOut = socketRequest(new Request("http://instance.test/maps/none"));
    const refusal = gateRequest(signedOut);
    expect(refusal.status).toBe(307);
    expect(await withPagePresence(signedOut, refusal)).toBe(refusal);
  });
});
