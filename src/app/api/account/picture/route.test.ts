// A received file's removal can be made to fail once.
const removal = vi.hoisted(() => ({ failNext: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const rm = (async (...args: Parameters<typeof actual.rm>) => {
    if (removal.failNext && String(args[0]).includes(`${path.sep}tmp${path.sep}`)) {
      removal.failNext = false;
      throw Object.assign(new Error("injected unlink failure"), { code: "EIO" });
    }
    return actual.rm(...args);
  }) as typeof actual.rm;
  return { ...actual, rm, default: { ...actual, rm } };
});
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { admittedReads, drainAccountWork } from "@/lib/auth/account-deletion-admission";
import { ownedFileRecords } from "@/lib/ingest/file-ownership";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { acceptAccountDeletion } from "@/lib/auth/account-deletion";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticatedRoute, TEST_ACCOUNT_ID } from "@/lib/assistant/testing/account";
import { testClient } from "@/lib/mcp/test-client";
import { RECORDS, gif, hugePng, orientedPortraitJpeg, svg, wideJpeg } from "../../../../../test-support/profile-picture-fixtures";
import { GET as readPicture } from "../../accounts/[sqlName]/picture/route";
import { DELETE, PUT } from "./route";

/**
 * Setting and removing one's own picture. Ada and Bo are people; Admin is an
 * admin. A write always acts on the signed-in account, the file is received
 * within the picture's fixed bounds and processed into the server's own
 * copy, and a refusal or failure leaves the current picture. The received
 * file goes once the processing has settled, whatever the outcome.
 */
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(root, "own-picture-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb();
  for (const id of ["ada", "bo", "admin"]) testAccountScope(undefined, id);
  metadataDb().exec("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'; UPDATE accounts SET last_sign_in_at = 'time'");
});
afterEach(() => { closeMetadataDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

const BOUNDARY = "picture-boundary";
function multipart(file: Buffer, name = "portrait.jpg", extra = "") {
  return Buffer.concat([
    Buffer.from(extra),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}
const upload = (account: string, file: Buffer, query = "", name?: string) =>
  PUT(testAccountRequest(new Request(`http://instance.test/api/account/picture${query}`, {
    method: "PUT", body: new Uint8Array(multipart(file, name)), headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  }), undefined, account));
const remove = (account: string) => DELETE(testAccountRequest(new Request("http://instance.test/api/account/picture", { method: "DELETE" }), undefined, account));
const version = (id: string) => getAccount(id)?.pictureVersion;
const served = async (sqlName: string) => {
  const response = await readPicture(testAccountRequest(new Request(`http://instance.test/api/accounts/${sqlName}/picture`), undefined, "bo"), { params: Promise.resolve({ sqlName }) });
  return response.status === 200 ? Buffer.from(await response.arrayBuffer()) : null;
};
/** Every file under the data folder, by path. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
const scratch = () => (existsSync(path.join(directory, "tmp")) ? readdirSync(path.join(directory, "tmp")) : []);
async function answer(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return await response.json() as { account?: { id: string; pictureVersion?: string }; error?: { code: string; message: string } };
}

describe("setting a picture", () => {
  it("keeps the server's own copy, a 320 pixel WebP with no record of the upload, and answers the account", async () => {
    const body = await answer(await upload("ada", await orientedPortraitJpeg()), 200);
    expect(body.account).toMatchObject({ id: "ada", pictureVersion: version("ada") });
    const bytes = (await served("ada"))!;
    const metadata = await sharp(bytes).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(["webp", 320, 320]);
    expect(metadata.exif ?? metadata.xmp ?? metadata.icc ?? metadata.iptc).toBeUndefined();
    for (const record of Object.values(RECORDS)) expect(bytes.includes(record), record).toBe(false);
    // Nothing of the upload is left anywhere in the data folder.
    for (const file of walk(directory)) {
      const content = readFileSync(file);
      for (const record of Object.values(RECORDS)) expect(content.includes(record), `${record} in ${file}`).toBe(false);
    }
    expect(scratch()).toEqual([]);
  });

  it("stores nothing where the file's name points", async () => {
    await answer(await upload("ada", await wideJpeg(), "", "../../../outside.jpg"), 200);
    const files = walk(directory).map((file) => path.relative(directory, file));
    expect(files.filter((file) => file.includes("outside"))).toEqual([]);
    expect(readdirSync(path.join(directory, "profile-pictures"))).toEqual([`ada.${version("ada")}.webp`]);
    expect(existsSync(path.join(root, "outside.jpg"))).toBe(false);
  });

  it("acts on the signed-in account whatever the request names, and removes only that account's", async () => {
    await answer(await upload("bo", await wideJpeg()), 200);
    const bos = version("bo");
    await answer(await upload("ada", await wideJpeg(), "?account=bo&sqlName=bo&id=bo"), 200);
    expect(version("bo")).toBe(bos);
    expect(version("ada")).toBeDefined();
    await answer(await remove("ada"), 200);
    expect(version("ada")).toBeUndefined();
    expect(version("bo")).toBe(bos);
  });

  it.each([
    ["an SVG", svg, 415, "unsupported_image"],
    ["a GIF", gif, 415, "unsupported_image"],
    ["more than 64 million pixels", async () => hugePng(), 413, "image_too_large"],
  ] as const)("refuses %s, keeps the current picture and leaves no received file", async (_, file, status, code) => {
    await answer(await upload("ada", await wideJpeg()), 200);
    const before = version("ada");
    expect((await answer(await upload("ada", await file()), status)).error?.code).toBe(code);
    expect(version("ada")).toBe(before);
    expect(scratch()).toEqual([]);
  });

  it("receives a file of exactly 10 MB and refuses one byte more before processing it", async () => {
    const jpeg = await wideJpeg();
    const exact = Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024 - jpeg.length)]);
    expect((await answer(await upload("ada", exact), 200)).account?.pictureVersion).toBe(version("ada"));
    const before = version("ada");
    const over = await answer(await upload("ada", Buffer.concat([exact, Buffer.from([0])])), 413);
    expect(over.error).toEqual({ code: "upload_too_large", message: "The file is over the 10 MB limit for a picture, which is fixed. Choose a still JPEG, PNG or WebP image." });
    expect(version("ada")).toBe(before);
    expect(scratch()).toEqual([]);
  });

  it("refuses a body over the envelope allowance however small its file", async () => {
    const padding = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${"x".repeat(10 * 1024 * 1024 + 64 * 1024)}\r\n`;
    const request = new Request("http://instance.test/api/account/picture", {
      method: "PUT", body: new Uint8Array(multipart(await wideJpeg(), "small.jpg", padding)), headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    });
    expect((await answer(await PUT(testAccountRequest(request, undefined, "ada")), 413)).error?.code).toBe("upload_too_large");
    expect(version("ada")).toBeUndefined();
    expect(scratch()).toEqual([]);
  });
});

describe("the received file", () => {
  it("stays on the account's work when it cannot be removed, so a deletion's drain removes it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    removal.failNext = true;
    expect((await answer(await upload("ada", await wideJpeg()), 200)).account?.pictureVersion).toBe(version("ada"));
    expect(scratch()).toHaveLength(1);
    expect(ownedFileRecords().filter((record) => record.file.startsWith("tmp")).map((record) => record.accountId)).toEqual(["ada"]);
    // The write answered, and its work stays held until the removal succeeds.
    expect(admittedReads("ada")).toBe(1);
    await drainAccountWork("ada");
    expect(admittedReads("ada")).toBe(0);
    expect(scratch()).toEqual([]);
    expect(ownedFileRecords().filter((record) => record.file.startsWith("tmp"))).toEqual([]);
  });
});

describe("removing a picture", () => {
  it("returns the initials, the old address serving nothing, and a second removal changes nothing", async () => {
    await answer(await upload("ada", await wideJpeg()), 200);
    expect(await served("ada")).not.toBeNull();
    const removed = await answer(await remove("ada"), 200);
    expect(removed.account).not.toHaveProperty("pictureVersion");
    expect(await served("ada")).toBeNull();
    expect((await answer(await remove("ada"), 200)).account).not.toHaveProperty("pictureVersion");
    expect(readdirSync(path.join(directory, "profile-pictures"))).toEqual([]);
  });
});

describe("the order of writes", () => {
  it("lets a removal sent while an upload is still arriving win, the late upload changing nothing", async () => {
    await answer(await upload("ada", await wideJpeg()), 200);
    const file = multipart(await wideJpeg()), split = 200, held = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(file.subarray(0, split)));
        await held.promise;
        controller.enqueue(new Uint8Array(file.subarray(split)));
        controller.close();
      },
    });
    const late = PUT(testAccountRequest(new Request("http://instance.test/api/account/picture", {
      method: "PUT", body, duplex: "half", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    } as RequestInit), undefined, "ada"));
    for (let turn = 0; turn < 20 && !scratch().length; turn++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scratch()).toHaveLength(1);
    expect((await answer(await remove("ada"), 200)).account).not.toHaveProperty("pictureVersion");
    held.resolve();
    expect((await answer(await late, 200)).account).not.toHaveProperty("pictureVersion");
    expect(version("ada")).toBeUndefined();
    expect(readdirSync(path.join(directory, "profile-pictures"))).toEqual([]);
    expect(scratch()).toEqual([]);
  });
});

describe("refusals in front", () => {
  it("refuses an account whose deletion has been accepted before its body is read", async () => {
    await answer(await upload("ada", await wideJpeg()), 200);
    const token = createApiToken(authenticateSession(issueSession(getAccount("ada")!, metadataDb(), Date.now()).secret)!, "Ada", metadataDb()).secret;
    metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'");
    const admin = authenticateSession(issueSession(getAccount("admin")!, metadataDb(), Date.now()).secret)!;
    acceptAccountDeletion(admin, "ada", () => {});
    for (const method of ["PUT", "DELETE"] as const) {
      const request = socketRequest(new Request("http://instance.test/api/account/picture", {
        method, body: method === "PUT" ? new Uint8Array(multipart(await wideJpeg())) : undefined,
        headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      }));
      const read = vi.spyOn(request, "body", "get");
      expect((await answer(await (method === "PUT" ? PUT : DELETE)(request), 401)).error?.code).toBe("authentication_required");
      expect(read).not.toHaveBeenCalled();
    }
    expect(metadataDb().prepare("SELECT picture_version FROM accounts WHERE id = 'ada'").get()).not.toEqual({ picture_version: null });
  });

  it("refuses a cookie-signed write without the instance's origin before reading the body", async () => {
    const signed = issueSession(getAccount("ada")!, metadataDb(), Date.now());
    const request = socketRequest(new Request("http://instance.test/api/account/picture", {
      method: "PUT", body: new Uint8Array(multipart(await wideJpeg())),
      headers: { cookie: `dezfil_session=${signed.secret}`, origin: "http://elsewhere.test", "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    }));
    const read = vi.spyOn(request, "body", "get");
    expect((await answer(await PUT(request), 403)).error?.code).toBe("forbidden");
    expect(read).not.toHaveBeenCalled();
    expect(version("ada")).toBeUndefined();
  });
});

describe("for an agent", () => {
  it("sets a picture of exactly 10 MB through base64 and removes it, through the real transport", async () => {
    const put = authenticatedRoute(PUT), del = authenticatedRoute(DELETE);
    const client = await testClient((request) => request.method === "PUT" ? put(request) : del(request));
    try {
      const jpeg = await wideJpeg();
      const exact = Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024 - jpeg.length)]);
      const set = await client.callTool({ name: "set_account_picture", arguments: { filename: "portrait.jpg", content_base64: exact.toString("base64") } });
      expect(set.isError ?? false).toBe(false);
      expect(version(TEST_ACCOUNT_ID)).toBeDefined();
      const over = await client.callTool({ name: "set_account_picture", arguments: { filename: "portrait.jpg", content_base64: Buffer.concat([exact, Buffer.from([0])]).toString("base64") } });
      expect(over.isError).toBe(true);
      expect(JSON.parse((over.content as { text: string }[])[0].text)).toMatchObject({ error: { code: "upload_too_large" } });
      const removed = await client.callTool({ name: "remove_account_picture", arguments: {} });
      expect(removed.isError ?? false).toBe(false);
      expect(version(TEST_ACCOUNT_ID)).toBeUndefined();
    } finally { await client.close(); }
  });

  it("changes only the caller's picture whichever account the arguments name", async () => {
    await answer(await upload("bo", await wideJpeg()), 200);
    const bos = version("bo");
    const put = authenticatedRoute(PUT), del = authenticatedRoute(DELETE);
    const client = await testClient((request) => request.method === "PUT" ? put(request) : del(request));
    try {
      const other = { id: "bo", sqlName: "bo", account: "bo", accountId: "bo" };
      const set = await client.callTool({ name: "set_account_picture", arguments: { filename: "portrait.jpg", content_base64: (await wideJpeg()).toString("base64"), ...other } });
      expect(set.isError ?? false).toBe(false);
      expect(version(TEST_ACCOUNT_ID)).toBeDefined();
      expect(version("bo")).toBe(bos);
      expect((await client.callTool({ name: "remove_account_picture", arguments: other })).isError ?? false).toBe(false);
      expect(version(TEST_ACCOUNT_ID)).toBeUndefined();
      expect(version("bo")).toBe(bos);
    } finally { await client.close(); }
  });
});
