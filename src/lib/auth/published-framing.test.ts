import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCH } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { activateSettingsStore } from "@/lib/settings/store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { gateRequest } from "./gate";

/**
 * Which other sites may show a published page in a frame, as the request
 * gate answers the page: no framing policy under Any site, one admitting
 * exactly the listed sites under Listed sites, and one admitting none
 * under Off. Each answer reads the stored choice afresh, so a save
 * applies from the next load; the published API responses never carry
 * the policy. Saves go through the change operation an admin's page uses.
 */

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); activateSettingsStore(f.db); });
afterEach(() => f.close());

async function save(body: Record<string, unknown>) {
  const response = await PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: JSON.stringify(body) })));
  expect(response.status).toBe(200);
}
const answer = (pathname: string, method = "GET") =>
  gateRequest(new NextRequest(socketRequest(new Request(`http://instance.test${pathname}`, { method }))));
const framing = (pathname: string, method = "GET") => answer(pathname, method).headers.get("content-security-policy");

const PAGES = ["/v/token", "/v/token?embed=1", "/v", "/v/token/extra"];
const SITES = ["https://www.stadtwerke.example", "http://intranet.example:8080"];
const LISTED = "frame-ancestors https://www.stadtwerke.example http://intranet.example:8080";
const OFF = "frame-ancestors 'none'";

describe("the published page's framing policy", () => {
  it("carries none under Any site, the default, and lets every page through", () => {
    for (const page of PAGES) for (const method of ["GET", "HEAD"]) {
      const response = answer(page, method);
      expect(response.headers.get("x-middleware-next"), `${method} ${page}`).toBe("1");
      expect(response.headers.get("content-security-policy"), `${method} ${page}`).toBeNull();
    }
  });

  it("admits exactly the listed sites under Listed sites", async () => {
    await save({ "publishing.embedding": "listed", "publishing.embedSites": SITES });
    for (const page of PAGES) for (const method of ["GET", "HEAD"]) {
      const response = answer(page, method);
      expect(response.headers.get("x-middleware-next"), `${method} ${page}`).toBe("1");
      expect(response.headers.get("content-security-policy"), `${method} ${page}`).toBe(LISTED);
    }
  });

  it("admits no site under Off", async () => {
    await save({ "publishing.embedding": "off" });
    for (const page of PAGES) for (const method of ["GET", "HEAD"]) {
      const response = answer(page, method);
      expect(response.headers.get("x-middleware-next"), `${method} ${page}`).toBe("1");
      expect(response.headers.get("content-security-policy"), `${method} ${page}`).toBe(OFF);
    }
  });

  it("follows each save from the next load", async () => {
    expect(framing("/v/token")).toBeNull();
    await save({ "publishing.embedding": "off" });
    expect(framing("/v/token")).toBe(OFF);
    await save({ "publishing.embedding": "listed", "publishing.embedSites": SITES });
    expect(framing("/v/token")).toBe(LISTED);
    await save({ "publishing.embedSites": [SITES[0]] });
    expect(framing("/v/token")).toBe("frame-ancestors https://www.stadtwerke.example");
    await save({ "publishing.embedding": "any" });
    expect(framing("/v/token")).toBeNull();
    await save({ "publishing.embedding": "off" });
    expect(framing("/v/token")).toBe(OFF);
  });

  it("leaves the published API responses and every other address unchanged", async () => {
    for (const choice of [{ "publishing.embedding": "off" }, { "publishing.embedding": "listed", "publishing.embedSites": SITES }]) {
      await save(choice);
      for (const [pathname, method] of [["/api/published/token", "GET"], ["/api/published/token", "HEAD"],
        ["/api/published/token/widget-values", "POST"], ["/api/published/token/render/layer", "POST"],
        ["/api/published/token/tiles/layer/1/2/3", "GET"], ["/api/health", "GET"], ["/icon.svg", "GET"],
        ["/vault", "GET"], ["/api/maps", "GET"]]) {
        expect(framing(pathname, method), `${method} ${pathname}`).toBeNull();
      }
    }
  });
});
