import { describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { issueSession } from "@/lib/auth/credentials";
import { dataDir } from "@/lib/config";
import { getAccount } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import * as shipped from "./shipped-index";

/**
 * The child half of the restart proof: this file does real work only when
 * spawned by `restart.test.ts` as a second process, pointed by its
 * environment at a data folder the parent filled and with the catalogue
 * blocked. It boots as the server boots, then drives the public routes; it
 * arranges nothing the proof is about. In the ordinary suite it records a
 * visible skip, never a vacuous pass.
 */

keepRequestsOnThisMachine();

const asChild = process.env.DEZFIL_TEMPLATES_RESTART_CHILD === "1";
const ORIGIN = "http://instance.test";

async function call(method: string, route: string, secret: string, extra: Record<string, string> = { origin: ORIGIN }) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method, headers: { cookie: `dezfil_session=${secret}`, ...extra },
  })));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

describe.skipIf(!asChild)("a restarted process over installed templates, the catalogue blocked", () => {
  it("keeps the engine's copies, opens, draws and copies both templates, refuses the catalogue, and counts the downloads under Templates", async () => {
    const expected = JSON.parse(process.env.DEZFIL_TEMPLATES_RESTART_EXPECT!) as {
      templates: { bytes: number; files: number };
      shippedCopies: Record<string, number>;
      left: string;
    };
    // The image's folder, which this checkout's own does not hold.
    vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(process.env.DEZFIL_TEMPLATES_RESTART_SHIPPED!);
    const { register } = await import("@/instrumentation");
    await register();

    // The boot sweep removed the staging a stopped process left and kept
    // the copies of shipped data: the same files, not copied again.
    const tables = path.join(dataDir(), "tables");
    expect(existsSync(path.join(tables, expected.left))).toBe(false);
    for (const [name, ino] of Object.entries(expected.shippedCopies)) expect(lstatSync(path.join(tables, name)).ino, name).toBe(ino);

    const db = metadataDb();
    const member = issueSession(getAccount("member", db)!, db, Date.now()).secret;
    const admin = issueSession(getAccount("admin", db)!, db, Date.now()).secret;

    const refreshed = await call("POST", "/api/templates/refresh", member);
    expect(refreshed.body).toMatchObject({ catalogue: { state: "refused", reason: "egress_blocked" } });
    expect((refreshed.body!.templates as { id: string; installed: number | null }[]).map((t) => `${t.id}@${t.installed}`).sort())
      .toEqual(["busy-stations@1", "harbour-stations@1", "quiet-park@1"]);

    for (const id of ["quiet-park", "harbour-stations", "busy-stations"]) {
      const map = await call("GET", `/api/maps/template.${id}.1.map`, member);
      expect(map.status, id).toBe(200);
      for (const layer of map.body!.layers as { id: string }[]) {
        expect((await call("GET", `/api/layers/${layer.id}/render`, member)).body, layer.id).toMatchObject({ ok: true });
      }
      const copy = await call("POST", `/api/templates/${id}/copy`, member);
      expect(copy.status, `${id}: ${JSON.stringify(copy.body)}`).toBe(201);
    }

    const storage = await call("GET", "/api/instance/storage", admin, { "sec-fetch-site": "same-origin" });
    expect(storage.status).toBe(200);
    const kinds = storage.body!.kinds as Record<string, { bytes: number; files: number; finished: boolean }>;
    expect(kinds.templates).toEqual({ ...expected.templates, finished: true });
    expect(kinds.leftover_files).toEqual({ bytes: 0, files: 0, finished: true });
    expect(kinds.tables.files).toBeGreaterThan(0);
  });
});
