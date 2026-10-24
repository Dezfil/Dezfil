// A picture's file read can be held open, to accept a deletion while it reads.
const reading = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const hold = reading.hold;
    if (hold && String(args[0]).includes("profile-pictures")) { reading.hold = null; await hold(); }
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { gateRequest } from "@/lib/auth/gate";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { testClient } from "@/lib/mcp/test-client";
import { admitPictureWrite, picturePath, publishPicture } from "@/lib/profile-pictures/store";
import { requireAccountScope } from "@/lib/auth/scope";
import { admittedReads } from "@/lib/auth/account-deletion-admission";
import { GET } from "./route";

/**
 * Reading a person's picture. Reader shares no project with anyone; Ada has
 * a picture, Dee has one and is deactivated, Gil has one and is under
 * deletion, Bo has none. Any active account reads any picture the person
 * reads name, by its current version or none; an earlier version, a person
 * without one, under deletion or unknown is the same 404. The browser may
 * keep a picture and ask again: the same checks decide, and an unchanged
 * picture is answered without its bytes.
 */
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(path.join(root, "picture-read-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb();
  for (const id of ["reader", "ada", "dee", "gil", "bo"]) testAccountScope(undefined, id);
  for (const id of ["ada", "dee", "gil"]) await set(id, `${id}-picture`);
  metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'dee'; UPDATE accounts SET status = 'deleting' WHERE id = 'gil'");
});
afterEach(() => { closeMetadataDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function set(id: string, picture: string | null) {
  const write = admitPictureWrite(id, id);
  try { await publishPicture(write, picture === null ? null : Buffer.from(picture), (db) => { requireAccountScope(testAccountScope(db, id), db); }); }
  finally { write.release(); }
}
const version = (id: string) => (metadataDb().prepare("SELECT picture_version FROM accounts WHERE id = ?").get(id) as { picture_version: string | null }).picture_version;
const read = (sqlName: string, query = "", headers: Record<string, string> = {}, account = "reader") =>
  GET(testAccountRequest(new Request(`http://instance.test/api/accounts/${sqlName}/picture${query}`, { headers }), undefined, account), { params: Promise.resolve({ sqlName }) });
async function refused(response: Response, status = 404) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return (await response.json() as { error: { code: string } }).error.code;
}

describe("the address", () => {
  it("serves the current picture by its version or without one, and an earlier version as no picture", async () => {
    const first = version("ada")!;
    for (const query of [`?v=${first}`, ""]) {
      const response = await read("ada", query);
      expect(response.status, query).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(await response.text()).toBe("ada-picture");
    }
    await set("ada", "ada-again");
    expect(await refused(await read("ada", `?v=${first}`))).toBe("not_found");
    expect(await (await read("ada", `?v=${version("ada")}`)).text()).toBe("ada-again");
    await set("ada", null);
    expect(await refused(await read("ada"))).toBe("not_found");
    expect(await refused(await read("bo"))).toBe("not_found");
    expect(await refused(await read("nobody"))).toBe("not_found");
    expect(await refused(await read("bo", "?v=anything"))).toBe("not_found");
  });

  it("answers no picture when the row's file is already gone", async () => {
    rmSync(picturePath("ada", version("ada")!));
    expect(await refused(await read("ada"))).toBe("not_found");
  });
});

describe("keeping a picture", () => {
  it("tags each answer by its bytes and answers an unchanged picture without them, after the same checks", async () => {
    const first = await read("ada");
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    for (const held of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
      const again = await read("ada", "", { "if-none-match": held });
      expect(again.status, held).toBe(304);
      expect(again.headers.get("etag")).toBe(tag);
      expect(again.headers.get("cache-control")).toBe("private, no-cache");
      expect(await again.text()).toBe("");
    }
    expect((await read("ada", "", { "if-none-match": '"stale"' })).status).toBe(200);
    // The reader deactivated, holding the tag: refused, not confirmed.
    metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'reader'");
    expect(await refused(await read("ada", "", { "if-none-match": tag }), 401)).toBe("authentication_required");
    metadataDb().exec("UPDATE accounts SET status = 'active' WHERE id = 'reader'");
    // The picture removed, its tag held: refused, not confirmed.
    await set("ada", null);
    expect(await refused(await read("ada", "", { "if-none-match": tag }))).toBe("not_found");
  });

  it("leaves the picture's answer to its route at the gate, and keeps every refusal unkept", () => {
    const signed = issueSession(getAccount("reader")!, metadataDb(), Date.now());
    const request = (headers: Record<string, string>) => new NextRequest(socketRequest(new Request("http://instance.test/api/accounts/ada/picture",
      { headers: { origin: "http://instance.test", ...headers } })));
    const admitted = gateRequest(request({ cookie: `dezfil_session=${signed.secret}` }));
    expect(admitted.headers.get("x-middleware-next")).toBe("1");
    expect(admitted.headers.get("cache-control")).toBeNull();
    // Signed out, or a published visitor holding only a published page's
    // address: refused before the route, unkept.
    for (const headers of [{}, { referer: "http://instance.test/v/published-token" }]) {
      const refusedHere = gateRequest(request(headers));
      expect(refusedHere.status).toBe(401);
      expect(refusedHere.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("refuses a request with no credential at the route too", async () => {
    const response = await GET(socketRequest(new Request("http://instance.test/api/accounts/ada/picture")), { params: Promise.resolve({ sqlName: "ada" }) });
    expect(await refused(response, 401)).toBe("authentication_required");
  });
});

describe("who reads", () => {
  it("serves any active account by session or token, with or without a shared project, a deactivated person's picture included", async () => {
    expect(await (await read("ada")).text()).toBe("ada-picture");
    expect(await (await read("dee")).text()).toBe("dee-picture");
    const token = createApiToken(authenticateSession(issueSession(getAccount("reader")!, metadataDb(), Date.now()).secret)!, "Reader", metadataDb()).secret;
    const bearer = await GET(socketRequest(new Request("http://instance.test/api/accounts/ada/picture", { headers: { authorization: `Bearer ${token}` } })),
      { params: Promise.resolve({ sqlName: "ada" }) });
    expect(await bearer.text()).toBe("ada-picture");
    expect(await (await read("ada", "", {}, "dee")).status).toBe(401);
  });

  it("answers a person under deletion as no picture", async () => {
    expect(await refused(await read("gil"))).toBe("not_found");
    expect(await refused(await read("gil", `?v=${version("gil")}`))).toBe("not_found");
  });

  it("ends a read whose person's deletion is accepted while it reads, and the deletion waits for it", async () => {
    const opened = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
    reading.hold = async () => { opened.resolve(); await proceed.promise; };
    const response = read("ada");
    await opened.promise;
    metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'ada'");
    // The deletion's first stage waits on this read.
    expect(admittedReads("ada")).toBe(1);
    proceed.resolve();
    expect(await refused(await response)).toBe("not_found");
    expect(admittedReads("ada")).toBe(0);
  });
});

describe("for an agent", () => {
  it("hands the picture over as an image through the real transport", async () => {
    const route = authenticatedRoute(GET);
    const client = await testClient((request) => route(request, { params: Promise.resolve({ sqlName: new URL(request.url).pathname.split("/").at(-2)! }) }));
    try {
      const result = await client.callTool({ name: "read_account_picture", arguments: { sqlName: "ada", v: version("ada") } });
      expect(result.isError ?? false).toBe(false);
      const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      const attachment = JSON.parse(content[0].text!).attachment;
      expect(Buffer.from(attachment.content_base64, "base64").toString()).toBe("ada-picture");
      expect(content[1]).toEqual({ type: "image", mimeType: "image/webp", data: attachment.content_base64 });
      const stale = await client.callTool({ name: "read_account_picture", arguments: { sqlName: "ada", v: "earlier" } });
      expect(stale.isError).toBe(true);
      expect(JSON.parse((stale.content as { text: string }[])[0].text)).toMatchObject({ error: { code: "not_found" } });
    } finally { await client.close(); }
  });
});
