import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { openRemote } from "@/lib/net/remote-fetch";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { CATALOGUE_INDEX_FILE, type CatalogueIndex } from "./format";
import { readTemplateArchive } from "./archive";
import { buildTemplate } from "../../../test-support/templates/builder";
import {
  startLoopbackCatalogue,
  writeFolderCatalogue,
  type LoopbackCatalogue,
} from "../../../test-support/templates/catalogue";

/**
 * The catalogue fixtures the template tests stand on, held to what they
 * claim: the loopback catalogue serves what it lists, records every request
 * with its headers on both hosts, redirects a release's download to the
 * second host through the product's own outbound engine under the egress
 * allowlist, holds a response until released, and stalls; the folder
 * fixture writes a catalogue on disk whose archives read back. Nothing
 * here leaves this machine.
 */

keepRequestsOnThisMachine();

let dir: string;
let catalogue: LoopbackCatalogue | null = null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-catalogue-"));
  process.env.DEZFIL_EGRESS_ALLOWLIST = "localhost,127.0.0.1";
});

afterEach(async () => {
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  await catalogue?.close();
  catalogue = null;
  await rm(dir, { recursive: true, force: true });
});

async function bodyOf(url: string, headers?: Record<string, string>) {
  const response = await openRemote(url, { timeoutMs: 5_000, headers });
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk as Buffer);
  return { status: response.statusCode, finalUrl: response.finalUrl, body: Buffer.concat(chunks) };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("the loopback catalogue", () => {
  it("serves the index it lists, and each archive and picture at its address", async () => {
    const built = await buildTemplate(path.join(dir, "a"));
    catalogue = await startLoopbackCatalogue();
    const published = await catalogue.publish([built]);
    const index = JSON.parse((await bodyOf(catalogue.indexUrl)).body.toString("utf8")) as CatalogueIndex;
    expect(index).toEqual(published);
    const [entry] = index.templates;
    expect(entry.facts.id).toBe("harbour-stations");
    const archive = await bodyOf(new URL(entry.archive, catalogue.indexUrl).href);
    expect(archive.body.length).toBe(entry.size);
    expect(sha256(archive.body)).toBe(entry.sha256);
    const light = await bodyOf(new URL(entry.pictures.light, catalogue.indexUrl).href);
    expect(light.body.equals(built.files.binaries.get("pictures/light.png")!)).toBe(true);
    expect(catalogue.requestsFor(`/${CATALOGUE_INDEX_FILE}`, "primary")).toHaveLength(1);
  });

  it("serves a release's download from the second host behind a redirect, every hop recorded with its headers", async () => {
    const built = await buildTemplate(path.join(dir, "a"));
    catalogue = await startLoopbackCatalogue();
    const [entry] = (await catalogue.publish([built], { releaseStyle: true })).templates;
    const fetched = await bodyOf(new URL(entry.archive, catalogue.indexUrl).href, { "user-agent": "fixture-check" });
    expect(fetched.finalUrl.startsWith(catalogue.secondOrigin)).toBe(true);
    expect(sha256(fetched.body)).toBe(entry.sha256);
    const hops = catalogue.requests.map((r) => [r.host, r.path, r.headers["user-agent"]]);
    expect(hops).toEqual([
      ["primary", "/archives/harbour-stations-1.zip", "fixture-check"],
      ["second", "/assets/harbour-stations-1.zip", "fixture-check"],
    ]);
  });

  it("leaves a redirect into blocked space to the egress check, which refuses it before contact", async () => {
    catalogue = await startLoopbackCatalogue();
    catalogue.redirect("/archives/blocked.zip", "http://10.255.255.1:9/x");
    await expect(bodyOf(`${catalogue.origin}/archives/blocked.zip`)).rejects.toMatchObject({ code: "egress_blocked" });
  });

  it("answers a status, holds a response until it is released, and stalls", async () => {
    catalogue = await startLoopbackCatalogue();
    catalogue.status("/gone.json", 404);
    expect((await openRemote(`${catalogue.origin}/gone.json`, { timeoutMs: 5_000 })).statusCode).toBe(404);

    const held = catalogue.hold("/held.zip", "held bytes");
    const pending = bodyOf(`${catalogue.origin}/held.zip`);
    await held.arrived;
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    held.release();
    expect((await pending).body.toString("utf8")).toBe("held bytes");

    catalogue.stall("/stalled.json");
    await expect(openRemote(`${catalogue.origin}/stalled.json`, { timeoutMs: 200 })).rejects.toMatchObject({ code: "remote_fetch_failed" });
    expect(catalogue.requestsFor("/stalled.json")).toHaveLength(1);
  });
});

describe("the folder catalogue", () => {
  it("writes the index and the archives it names, which read back as the templates they were built from", async () => {
    const map = await buildTemplate(path.join(dir, "a"));
    const workflow = await buildTemplate(path.join(dir, "b"), { kind: "workflow" });
    const folder = path.join(dir, "catalogue");
    const index = await writeFolderCatalogue(folder, [map, workflow]);
    expect(JSON.parse(await readFile(path.join(folder, CATALOGUE_INDEX_FILE), "utf8"))).toEqual(index);
    for (const [i, entry] of index.templates.entries()) {
      const bytes = await readFile(path.join(folder, entry.archive));
      expect(sha256(bytes)).toBe(entry.sha256);
      const read = await readTemplateArchive(path.join(folder, entry.archive), path.join(dir, `unpacked-${i}`));
      expect(read.admitted.facts).toEqual(entry.facts);
    }
  });
});
