import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { GET as releasesRoute } from "@/app/api/imports/overture/releases/route";
import { egressBlockedError } from "@/lib/net/egress";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { listOvertureReleases, resetReleaseCache } from "./releases";

/**
 * The Overture release listing goes through the egress check like every
 * other request the server makes for a person: a mirror in private space is
 * listed once the allowlist names it, refused (to the pane too) while it does
 * not, and a redirect into blocked space is refused before anything is sent.
 * An outage keeps the pinned fallback, and Check now asks the mirror again
 * past the list kept in this process.
 */

// The mirror is a loopback fixture; a listing that went to the public bucket
// instead fails its test before it leaves this machine.
keepRequestsOnThisMachine();

const FALLBACK = ["2026-06-17.0", "2026-05-20.0"];
const listing = (...releases: string[]) =>
  `<ListBucketResult>${releases.map(release => `<CommonPrefixes><Prefix>release/${release}/</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;

let fixtures: Server[] = [];

/** A loopback mirror that records each path it is asked. */
async function mirror(answer: (res: ServerResponse) => void) {
  const asked: string[] = [];
  const server = createServer((req, res) => { asked.push(req.url ?? ""); answer(res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  fixtures.push(server);
  return { asked, port: (server.address() as AddressInfo).port };
}
const lists = (...releases: string[]) => (res: ServerResponse) => { res.writeHead(200, { "content-type": "application/xml" }); res.end(listing(...releases)); };
const seam = (port: number) => vi.stubEnv("DEZFIL_OVERTURE_S3_ENDPOINT", `127.0.0.1:${port}`);

beforeEach(() => {
  resetReleaseCache();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
});

afterEach(async () => {
  resetReleaseCache();
  vi.unstubAllEnvs();
  await Promise.all(fixtures.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  fixtures = [];
});

describe("the release listing under the egress check", () => {
  it("lists a mirror the allowlist names, newest first", async () => {
    const listed = await mirror(lists("2026-08-20.0", "2026-09-17.0"));
    seam(listed.port);
    await expect(listOvertureReleases()).resolves.toEqual(["2026-09-17.0", "2026-08-20.0"]);
    expect(listed.asked).toEqual(["/overturemaps-us-west-2/?list-type=2&prefix=release/&delimiter=/"]);
  });

  it("refuses a private mirror the allowlist does not name, before contact", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    const listed = await mirror(lists("2026-09-17.0"));
    seam(listed.port);
    await expect(listOvertureReleases()).rejects.toMatchObject({ code: "egress_blocked", status: 403, message: egressBlockedError().message });
    expect(listed.asked).toEqual([]);
  });

  it("refuses a redirect into blocked space, before contact", async () => {
    // Allowlisted by its literal, the mirror sends the listing on to the
    // unspecified address, which the allowlist does not name.
    const elsewhere = await mirror(lists("2026-09-17.0"));
    const listed = await mirror(res => { res.writeHead(302, { location: `http://0.0.0.0:${elsewhere.port}/listing` }); res.end(); });
    seam(listed.port);
    await expect(listOvertureReleases()).rejects.toMatchObject({ code: "egress_blocked", status: 403 });
    expect(listed.asked).toHaveLength(1);
    expect(elsewhere.asked).toEqual([]);
  });

  it("is refused to the pane at a blocked mirror", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    const listed = await mirror(lists("2026-09-17.0"));
    seam(listed.port);
    const response = await releasesRoute();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "egress_blocked", message: egressBlockedError().message } });
    expect(listed.asked).toEqual([]);
  });
});

describe("an outage", () => {
  it.each([
    ["a mirror that does not answer", "closed"],
    ["a mirror answering with a status", "503"],
    ["a listing with no release in it", "empty"],
  ] as const)("keeps the pinned fallback: %s", async (_name, kind) => {
    const listed = await mirror(res => {
      if (kind === "503") { res.writeHead(503); res.end("slow down"); } else lists()(res);
    });
    seam(listed.port);
    if (kind === "closed") await new Promise<void>(resolve => fixtures.pop()!.close(() => resolve()));
    await expect(listOvertureReleases()).resolves.toEqual(FALLBACK);
    const response = await releasesRoute();
    expect(await response.json()).toEqual({ releases: FALLBACK, latest: FALLBACK[0] });
  });
});

describe("Check now", () => {
  it("asks the mirror again past the list kept in this process, and keeps what it finds", async () => {
    let answer = lists("2026-08-20.0");
    const listed = await mirror(res => answer(res));
    seam(listed.port);
    await expect(listOvertureReleases()).resolves.toEqual(["2026-08-20.0"]);
    answer = lists("2026-08-20.0", "2026-09-17.0");
    await expect(listOvertureReleases()).resolves.toEqual(["2026-08-20.0"]);
    expect(listed.asked).toHaveLength(1);
    await expect(listOvertureReleases({ refresh: true })).resolves.toEqual(["2026-09-17.0", "2026-08-20.0"]);
    await expect(listOvertureReleases()).resolves.toEqual(["2026-09-17.0", "2026-08-20.0"]);
    expect(listed.asked).toHaveLength(2);
  });
});
