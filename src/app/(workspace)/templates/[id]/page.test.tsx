import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { TemplateView } from "@/components/templates/TemplateView";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { refreshCatalogue, resetCatalogueForTests } from "@/lib/templates/catalogue";
import type { TemplateDetail } from "@/lib/templates/card";
import type { OpenedTemplate } from "@/lib/templates/opened";
import * as shippedIndex from "@/lib/templates/shipped-index";
import { instanceSettingsFixture } from "../../../../../test-support/instance-settings";
import { buildTemplate, installFixture, writeShippedFolder, type BuiltTemplate } from "../../../../../test-support/templates/builder";
import { writeFolderCatalogue } from "../../../../../test-support/templates/catalogue";
import TemplatePage from "./page";

/**
 * A template's own address, for every signed-in account: the version the
 * read of one names, with its installed documents when it is on this
 * server and none when it is only listed (the page downloads it first).
 * An id no one lists is not found; an anonymous request is sent to sign in.
 *
 * A map template shipped in the image, a workflow example downloaded at
 * version 1 while the catalogue folder lists its version 2, and a third
 * listed by the folder but not installed.
 */

vi.mock("@/components/templates/TemplateView", () => ({ TemplateView: () => null }));
const who = vi.hoisted(() => ({ account: null as string | null, db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () => {
    const request = new Request("http://instance.test/templates/harbour-stations");
    return who.account === null
      ? socketRequest(request).headers
      : testAccountRequest(request, who.db as import("better-sqlite3").Database, who.account).headers;
  },
}));

let built: string;
let M1: BuiltTemplate, W1: BuiltTemplate, W2: BuiltTemplate, Q1: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-page-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
  W2 = await buildTemplate(path.join(built, "w2"), { kind: "workflow", id: "busy-stations", version: 2, title: "Busy stations, renewed" });
  Q1 = await buildTemplate(path.join(built, "q1"), { id: "quiet-park", title: "Quiet park" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  who.db = f.db;
  resetCatalogueForTests();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-page-run-"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [M1]));
  await installFixture(W1, path.join(f.dir, "templates", "busy-stations", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
  const folder = path.join(dir, "catalogue");
  await writeFolderCatalogue(folder, [W2, Q1]);
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", folder);
});
afterEach(async () => {
  resetCatalogueForTests();
  who.account = null;
  f.close();
  await rm(dir, { recursive: true, force: true });
});

type Props = { template: TemplateDetail; opened: OpenedTemplate | null; basemaps: unknown[] };
async function open(account: string | null, id: string) {
  who.account = account;
  return (await TemplatePage({ params: Promise.resolve({ id }) })) as ReactElement<Props>;
}

describe("a template's address", () => {
  it.each([["an admin", "admin"], ["a member", "member"]])("opens an installed map template for %s, on its map's id", async (_who, account) => {
    const page = await open(account, "harbour-stations");
    expect(page.type).toBe(TemplateView);
    expect(page.props.template).toMatchObject({ id: "harbour-stations", version: 1, present: true, kind: "map" });
    expect(page.props.template.howMade.datasets.map((d) => d.dataset)).toEqual(["stations", "districts"]);
    expect(page.props.opened).toMatchObject({ id: "harbour-stations", version: 1, mapId: "template.harbour-stations.1.map", workflow: null });
    expect(Array.isArray(page.props.basemaps)).toBe(true);
  });

  it("opens a downloaded workflow example with its workflow's documents", async () => {
    const page = await open("member", "busy-stations");
    expect(page.props.template).toMatchObject({ id: "busy-stations", version: 1, present: true, kind: "workflow" });
    expect(page.props.opened!.workflow!.steps.map((s) => s.id)).toEqual(["step-busy", "step-rings"]);
  });

  it("hands a version only listed over with no documents, for the page to download first", async () => {
    await refreshCatalogue(f.db);
    const page = await open("member", "quiet-park");
    expect(page.props.template).toMatchObject({ id: "quiet-park", version: 1, present: false, installed: null, listed: 1 });
    expect(page.props.opened).toBeNull();
  });

  it("opens the version the read names, never an older one installed: a newer listed version is downloaded first", async () => {
    await refreshCatalogue(f.db);
    const page = await open("member", "busy-stations");
    expect(page.props.template).toMatchObject({ id: "busy-stations", version: 2, present: false, installed: 1, listed: 2 });
    expect(page.props.opened).toBeNull();
  });

  it("is not found for an id no one lists", async () => {
    await expect(open("member", "no-such-template")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    // Listed only once the catalogue is read: not before.
    await expect(open("member", "quiet-park")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("sends an anonymous request to sign in", async () => {
    let thrown: unknown;
    try { await open(null, "harbour-stations"); } catch (error) { thrown = error; }
    expect(String((thrown as { digest?: string })?.digest)).toMatch(/^NEXT_REDIRECT;[a-z]+;\/sign-in;/);
  });
});
