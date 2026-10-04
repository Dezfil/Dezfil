import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

const io = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn(), lookup: vi.fn(), resolved: [] as string[][] }));
vi.mock("@/lib/duckdb", () => ({
  withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) =>
    work({ run: io.run, runAndReadAll: io.read } as unknown as DuckDBConnection),
}));
vi.mock("@/lib/net/egress", async (original) => {
  const actual = await original<typeof import("@/lib/net/egress")>();
  return { ...actual, resolveAllowed: async (host: string) => {
    const addresses = await actual.resolveAllowed(host, io.lookup);
    io.resolved.push(addresses);
    return addresses;
  } };
});
import { testConnection } from "./access";
import { POST } from "@/app/api/connections/postgis/route";
import { PATCH } from "@/app/api/connections/postgis/[id]/route";
import { POST as TEST } from "@/app/api/connections/postgis/[id]/test/route";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { connectionPassword, getConnection, insertConnection } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";

const blocked = "The requested address is not reachable from this server: loopback, private-network, link-local, and metadata addresses are blocked by default. Specific hosts can be allowed with DEZFIL_EGRESS_ALLOWLIST.";
const target = { host: "", port: 5432, database: "gis", username: "reader", password: "fixture-secret", ssl: true };
const attachments = () => io.run.mock.calls.filter(([sql]) => String(sql).startsWith("ATTACH "));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.cwd(), ".tmp-ipv6-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetSecretKeyCache();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  io.run.mockReset().mockResolvedValue(undefined);
  io.read.mockReset().mockResolvedValue({ getRowObjects: () => [{ v: "fixture-version" }] });
  io.lookup.mockReset(); io.resolved.length = 0;
});
afterEach(() => {
  closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

for (const arm of ["failure", "answer"] as const) {
  describe(`IPv6 connection boundary with lookup ${arm}`, () => {
    for (const literal of ["::1", "fd00::1", "2001:4860:4860::8888"]) {
      for (const host of [literal, `[${literal}]`]) {
        it(`${host} classifies without lookup and pins only the admitted literal`, async () => {
          io.lookup.mockImplementation(async () => {
            if (arm === "failure") throw Object.assign(new Error("injected lookup failure"), { code: "ENOTFOUND" });
            return [{ address: "2001:4860:4860::8844", family: 6 }];
          });
          const error = await testConnection({ ...target, host }).then(() => null, (e) => e);
          const pinned = attachments().map(([sql]) => String(sql).match(/hostaddr=''([^']+)''/)?.[1] ?? null);
          console.info(JSON.stringify({ arm, host, lookups: io.lookup.mock.calls, returned: io.resolved, error: error ? { status: error.status, code: error.code } : null, pinned }));
          expect.soft(io.lookup).not.toHaveBeenCalled();
          if (literal === "2001:4860:4860::8888") {
            expect.soft(error).toBeNull();
            expect.soft(io.resolved).toEqual([["2001:4860:4860::8888"]]);
            expect.soft(pinned).toEqual(["2001:4860:4860::8888"]);
          } else {
            expect.soft(error).toMatchObject({ status: 403, code: "egress_blocked", message: blocked });
            expect.soft(io.resolved).toEqual([]);
            expect.soft(io.run).not.toHaveBeenCalled();
            expect.soft(pinned).toEqual([]);
          }
        });
      }
    }
  });
}

function request(body: unknown) {
  return testAccountRequest(new Request("http://localhost/api/connections/postgis", { method: "POST", body: JSON.stringify(body) }));
}
const params = { params: Promise.resolve({ id: "saved" }) };
const forms = {
  uri: (host: string) => ({ url: `postgres://reader:fixture-secret@${host}:5432/gis` }),
  libpq: (host: string) => ({ url: `host='${host}' dbname=gis user=reader password=fixture-secret` }),
  fields: (host: string) => ({ ...target, host }),
};
for (const [form, input] of Object.entries(forms)) {
  for (const operation of ["create", "edit"] as const) {
    describe(`${form} ${operation} reaches the real resolver`, () => {
      it.each(["::1", "fd00::1", "2001:4860:4860::8888"])("preserves submitted [%s] but pins its bare address", async (literal) => {
        const host = `[${literal}]`;
        if (operation === "edit") insertConnection(testAccountScope(), { ...target, id: "saved", name: "Prior", host: "old.example.org" });
        io.lookup.mockRejectedValue(new Error("literals must not resolve"));
        const req = request({ name: "IPv6", ...input(host) });
        const response = operation === "create" ? await POST(req) : await PATCH(req, params);
        expect(io.lookup).not.toHaveBeenCalled();
        if (literal !== "2001:4860:4860::8888") {
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({ error: { code: "egress_blocked", message: blocked } });
          expect(io.run).not.toHaveBeenCalled();
        } else {
          expect(response.status).toBe(operation === "create" ? 201 : 200);
          const connection = await response.json();
          expect(getConnection(testAccountScope(), connection.id)?.host).toBe("[2001:4860:4860::8888]");
          expect(metadataDb().prepare("SELECT host FROM pg_connections WHERE id = ?").get(connection.id)).toEqual({ host: "[2001:4860:4860::8888]" });
          expect(attachments()[0][0]).toContain("host=''[2001:4860:4860::8888]''");
          expect(attachments()[0][0]).toContain("hostaddr=''2001:4860:4860::8888''");
        }
      });
    });
  }
}

it.each([
  ["2001:4860:4860::8888", "[2001:4860:4860::8888]"],
  ["[2001:4860:4860::8888]", "2001:4860:4860::8888"],
])("passwordless equivalent edit from %s to %s keeps credential and submitted spelling", async (prior, host) => {
  insertConnection(testAccountScope(), { ...target, id: "saved", name: "Prior", host: prior });
  const response = await PATCH(request({ host, password: "" }), params);
  expect(response.status).toBe(200);
  expect(getConnection(testAccountScope(), "saved")?.host).toBe(host);
  expect(connectionPassword(testAccountScope(), "saved")).toBe("fixture-secret");
  expect(attachments()[0][0]).toContain("hostaddr=''2001:4860:4860::8888''");
  expect(io.lookup).not.toHaveBeenCalled();
});

it.each(["[::1]", "[2001:4860:4860::8888]"])("testing previously stored %s uses the resolver", async (host) => {
  insertConnection(testAccountScope(), { ...target, id: "saved", name: "Prior", host });
  const response = await TEST(request({}), params);
  expect(response.status).toBe(host === "[::1]" ? 403 : 200);
  expect(io.lookup).not.toHaveBeenCalled();
  expect(getConnection(testAccountScope(), "saved")?.host).toBe(host);
  if (host === "[::1]") expect(io.run).not.toHaveBeenCalled();
  else expect(attachments()[0][0]).toContain("hostaddr=''2001:4860:4860::8888''");
});

it.each([{ host: "2001:4860:4860::8844" }, { port: 5433 }, { ssl: false }])("retains password reentry for %j", async (change) => {
  insertConnection(testAccountScope(), { ...target, id: "saved", name: "Prior", host: "[2001:4860:4860::8888]" });
  const response = await PATCH(request(change), params);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("connection_password_required");
  expect(io.lookup).not.toHaveBeenCalled();
  expect(io.run).not.toHaveBeenCalled();
});
