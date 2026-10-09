import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { closeMetadataDb } from "@/lib/metadata/db";
import { openRemote } from "@/lib/net/remote-fetch";
import { DEFAULT_OVERPASS_ENDPOINT } from "@/lib/osm/overpass";
import { settingRemedy } from "@/lib/settings/remedy";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { POST } from "./route";

/**
 * Overpass's own words in an import's refusal, on both of the ways a server
 * gives them: the page a failing status sends, and the error remark of an
 * answer. They are passed on only when the address in effect has nothing in
 * it that could hold a key: no user information, no query, no fragment, and
 * a path an Overpass server is published at. At any other address they are
 * withheld whatever they say, the forms a key can be repeated in being more
 * than any list of them names.
 */

// The outbound engine as shipped. One test answers in its place for the
// public default address, so that request never leaves this machine.
vi.mock("@/lib/net/remote-fetch", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/net/remote-fetch")>();
  return { ...actual, openRemote: vi.fn(actual.openRemote) };
});

keepRequestsOnThisMachine();

type Branch = "page" | "remark";
type Words = (req: IncomingMessage) => string;

/** Words an Overpass server gives for a query it cannot read. */
const ORDINARY = "line 1: parse error: unknown type \"nod\"";
const NOT_SHOWN = "Its message is not shown for an address with a path, a query or a user name.";

let dir: string;
let server: Server;
let port: number;
/** What the fixture says next, made from the request it answers. */
let says: { branch: Branch; status: number; words: Words };

/** The page a failing status sends, or an answer whose remark is an error. */
function body(branch: Branch, words: string): string {
  return branch === "page" ? `<html><body><p><strong>${words}</strong></p></body></html>`
    : JSON.stringify({ version: 0.6, elements: [], remark: `runtime error: ${words}` });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  closeMetadataDb();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const { branch, status, words } = says;
      res.writeHead(branch === "page" ? status : 200, { "content-type": branch === "page" ? "text/html" : "application/json" });
      res.end(body(branch, words(req)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  closeMetadataDb();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** The fixture's scheme and host, which a refusal names. */
const origin = () => `http://127.0.0.1:${port}`;

/** The import's answer with the Overpass address set to `address`. */
async function imported(address: string | undefined): Promise<{ status: number; body: unknown }> {
  vi.stubEnv("DEZFIL_OVERPASS_URL", address);
  const request = new Request("http://instance.test/api/imports/osm", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bbox: [13.3, 52.4, 13.5, 52.6], selectors: ["amenity=cafe"], name: "cafes" }),
  });
  const response = await POST(testAccountRequest(request));
  return { status: response.status, body: await response.json() };
}

/** The refusal the import answers with: the server's words passed on, or
 * the endpoint, the status, that they are not shown and what to do. */
function refusal(branch: Branch, status: number, at: string, words?: string) {
  const message = branch === "page"
    ? words ? `The Overpass endpoint ${at} responded ${status}: ${words}`
      : `The Overpass endpoint ${at} responded ${status}. ${NOT_SHOWN} ${settingRemedy("overpassUrl")}`
    : words ? `Overpass reported: runtime error: ${words}. Narrow the area or the tags and retry.`
      : `The Overpass endpoint ${at} responded 200 with an error. ${NOT_SHOWN} Narrow the area or the tags and retry.`;
  return { status: 502, body: { error: { code: "remote_fetch_failed", message } } };
}

/** The credential a request was sent, as the pair it encodes. */
const pair = (req: IncomingMessage) => Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
/** A query value of the request, as the server read it. */
const value = (req: IncomingMessage) => new URL(req.url ?? "", "http://fixture").searchParams.get("key") ?? "";
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const withUser = (at: string) => at.replace("//", "//SEED-USER:SEEDED-KEY-PASS@");

describe.each([
  ["the page a failing status sends", "page"],
  ["an error remark", "remark"],
] as const)("Overpass's own words in %s", (_where, branch) => {
  // Each address has something past its host that may hold a key; each
  // server's words, made from the request, repeat it in their own way or
  // not at all.
  it.each<[string, (at: string) => string, Words, number?]>([
    ["a short path segment", at => `${at}/SEED-SHORT/interpreter`, req => `no instance ${(req.url ?? "").split("/")[1]}`],
    ["a query secret, HTML-escaped", at => `${at}/api/interpreter?key=SEEDED-KEY%26QUERY`, req => `bad key ${escaped(value(req))}`],
    ["a query secret behind a prefix, in base64", at => `${at}/api/interpreter?key=SEEDED-KEY-QUERY`,
      req => `bad token ${Buffer.from(`Bearer ${value(req)}`).toString("base64")}`],
    ["the whole address it was asked at, its credential included", at => `${withUser(at)}/SEEDED-KEY-PATH/api/interpreter?key=SEEDED-KEY-QUERY`,
      req => `Not found: http://${pair(req)}@${req.headers.host}${req.url}`, 404],
    ["the Basic credential it was sent, in base64", at => `${withUser(at)}/api/interpreter`, req => `refused ${req.headers.authorization}`],
    ["a password sent with no user name", at => `${at.replace("//", "//:SEEDED-KEY-PASS@")}/api/interpreter`, req => `refused ${req.headers.authorization}`],
    ["nothing of the address, a key in its path", at => `${at}/SEEDED-KEY-PATH/api/interpreter`, () => ORDINARY],
    ["nothing of the address, a user name", at => `${at.replace("//", "//SEED-USER@")}/api/interpreter`, () => ORDINARY],
    ["nothing of the address, a query", at => `${at}/api/interpreter?key=SEEDED-KEY-QUERY`, () => ORDINARY],
    ["nothing of the address, a fragment", at => `${at}/api/interpreter#SEEDED-KEY-FRAGMENT`, () => ORDINARY],
  ])("are withheld when they repeat %s", async (_what, address, words, status = 400) => {
    says = { branch, status, words };
    expect(await imported(address(origin()))).toEqual(refusal(branch, status, origin()));
  });

  it.each<[string, (at: string) => string]>([
    ["a private server at /api/interpreter", at => `${at}/api/interpreter`],
    ["/api/interpreter with a trailing slash", at => `${at}/api/interpreter/`],
    ["/interpreter", at => `${at}/interpreter`],
    ["/interpreter with a trailing slash", at => `${at}/interpreter/`],
    ["a server at its root", at => `${at}/`],
    ["a server with no path", at => at],
  ])("are passed on at %s", async (_what, address) => {
    says = { branch, status: 400, words: () => ORDINARY };
    expect(await imported(address(origin()))).toEqual(refusal(branch, 400, origin(), ORDINARY));
  });

  it("are passed on at the public default address", async () => {
    // The default's answer is made here, in the outbound engine's place.
    const asked: string[] = [];
    vi.mocked(openRemote).mockImplementationOnce(async url => {
      asked.push(url);
      return { statusCode: branch === "page" ? 400 : 200, headers: {}, finalUrl: url,
        body: Readable.from([Buffer.from(body(branch, ORDINARY))]) as unknown as IncomingMessage };
    });
    expect(await imported(undefined)).toEqual(refusal(branch, 400, "https://overpass-api.de", ORDINARY));
    expect(asked).toEqual([DEFAULT_OVERPASS_ENDPOINT]);
  });
});
