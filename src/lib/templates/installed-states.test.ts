import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import { startLoopbackCatalogue, type LoopbackCatalogue } from "../../../test-support/templates/catalogue";
import { REFRESH_WINDOW_MS, refreshCatalogue, resetCatalogueForTests } from "./catalogue";
import { CATALOGUE_INDEX_FILE } from "./format";
import * as shipped from "./shipped-index";

/**
 * The installed set does not depend on the catalogue: a shipped template
 * and one downloaded while the catalogue listed it each open, draw and copy
 * whatever state the catalogue is in now (switched off, unreachable, slow,
 * empty, refusing with a status, refused by the egress rules), and doing so
 * sends the catalogue nothing.
 */

keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
let f: ReturnType<typeof instanceSettingsFixture>;
let catalogue: LoopbackCatalogue;
let dir: string;
let built: string;
let A1: BuiltTemplate, C1: BuiltTemplate;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-states-"));
  A1 = await buildTemplate(path.join(built, "a1"), { id: "harbour-stations", version: 1 });
  C1 = await buildTemplate(path.join(built, "c1"), { id: "quiet-park", version: 1, title: "Quiet park" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-states-run-"));
  vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [C1]));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "localhost,127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32));
  resetSecretKeyCache();
  resetCatalogueForTests();
  catalogue = await startLoopbackCatalogue();
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl);
  await catalogue.publish([A1]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await catalogue.close();
  resetCatalogueForTests();
  resetQueryInstance();
  f.close();
  resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

async function call(method: string, route: string) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method, headers: { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN },
  })));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const states: [string, () => Promise<void>, string][] = [
  ["switched off", async () => { writeStoredSettings({ "templates.catalogue": false }, f.db); }, "off"],
  ["unreachable", async () => { vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", `http://127.0.0.1:${await closedPort()}/index.json`); }, "unreachable"],
  ["slow", async () => { vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "0.2"); catalogue.stall(`/${CATALOGUE_INDEX_FILE}`); }, "slow"],
  ["empty", async () => { await catalogue.publish([]); }, "empty"],
  ["refusing with a status", async () => { catalogue.status(`/${CATALOGUE_INDEX_FILE}`, 503); }, "refused"],
  // Asked by its address, so the check stands before any request: a
  // connection the fetch left open to the name would be reused unchecked,
  // which a server whose rules are fixed at its start never meets.
  ["refused by the egress rules", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", `http://127.0.0.1:${new URL(catalogue.indexUrl).port}/${CATALOGUE_INDEX_FILE}`);
  }, "refused"],
];

describe("the installed set, whatever the catalogue's state", () => {
  it.each(states)("%s: the shipped and the downloaded template each open, draw and copy, sending nothing", async (_name, arrange, state) => {
    // Downloaded while the catalogue listed it.
    expect((await call("POST", "/api/templates/refresh")).status).toBe(200);
    expect((await call("POST", "/api/templates/harbour-stations/fetch")).body).toMatchObject({ version: 1, downloaded: true });

    await arrange();
    // The catalogue is read again, past its ten minutes, into its new state.
    const now = Date.now() + REFRESH_WINDOW_MS + 1;
    const list = await refreshCatalogue(f.db, { now }).catch(async (error: unknown) => {
      expect(error).toMatchObject({ code: "templates_catalogue_off" });
      return (await call("GET", "/api/templates")).body as { catalogue: { state: string } };
    });
    expect(list.catalogue.state).toBe(state);
    const sent = catalogue.requests.length;

    for (const [id, layer] of [["quiet-park", "layer-stations"], ["harbour-stations", "layer-stations"]]) {
      const map = await call("GET", `/api/maps/template.${id}.1.map`);
      expect(map.status, id).toBe(200);
      expect((map.body!.layers as unknown[]).length, id).toBeGreaterThan(0);
      expect((await call("GET", `/api/layers/template.${id}.1.layer.${layer}/render`)).body, id).toMatchObject({ ok: true });
      const copy = await call("POST", `/api/templates/${id}/copy`);
      expect(copy.status, `${id}: ${JSON.stringify(copy.body)}`).toBe(201);
    }
    expect(catalogue.requests).toHaveLength(sent);
  });
});
