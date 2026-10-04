import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";

const io = vi.hoisted(() => ({ resolve: vi.fn(), lookup: vi.fn(), run: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/duckdb", () => ({
  withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) =>
    work({ run: io.run, runAndReadAll: io.read } as unknown as DuckDBConnection),
}));
vi.mock("@/lib/net/egress", async (original) => {
  const actual = await original<typeof import("@/lib/net/egress")>();
  return { ...actual, resolveAllowed: (host: string) => {
    io.resolve(host);
    return actual.resolveAllowed(host, io.lookup);
  } };
});
import { POST } from "@/app/api/connections/postgis/route";
import { PATCH } from "@/app/api/connections/postgis/[id]/route";
import { POST as TEST } from "@/app/api/connections/postgis/[id]/test/route";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertConnection, recordConnectionCheck } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";

// Independent examples, including every ignored/absent control. Never import
// the production policy: an omitted production entry must fail this matrix.
const inventory: [string, string[], string[]][] = [
  ["channel_binding", ["require", "surprise", "PREFER"], ["prefer", "disable"]],
  ["ssl_min_protocol_version", ["TLSv1.2"], []],
  ["ssl_max_protocol_version", ["TLSv1.3"], []],
  ["gssencmode", ["require", "surprise"], ["prefer", "disable"]],
  ["sslrootcert", ["/distinctive/root.pem", "system"], []],
  ["sslcrl", ["/distinctive/revoked.pem"], []],
  ["sslcrldir", ["/distinctive/revocations"], []],
  ["sslcert", ["/distinctive/client.pem"], []],
  ["sslkey", ["/distinctive/client.key"], []],
  ["sslpassword", ["certificate-secret"], []],
  ["sslcertmode", ["require", "disable", "surprise"], ["allow"]],
  ["require_auth", ["scram-sha-256"], []],
  ["krbsrvname", ["distinctive-principal"], []],
  ["gsslib", ["gssapi"], []],
  ["sslsni", ["0", "surprise"], ["1"]],
  ["sslcompression", ["surprise"], ["0", "1"]],
  ["gssdelegation", ["surprise"], ["0", "1"]],
  ["sslnegotiation", ["direct", "surprise"], ["postgres"]],
  ["requiressl", ["1", "surprise"], ["0"]],
  ["ssl", ["true", "1", "surprise"], ["false"]],
  ["scram_client_key", ["distinctive-client-key"], []],
  ["scram_server_key", ["distinctive-server-key"], []],
  ["oauth_issuer", ["https://issuer.example.test"], []],
  ["oauth_client_id", ["distinctive-client-id"], []],
  ["oauth_client_secret", ["distinctive-oauth-secret"], []],
  ["oauth_scope", ["restricted scope"], []],
  ["requirepeer", [], ["distinctive-peer"]],
];
type Entries = [string, string][];
const forms = {
  uri: (entries: Entries) => `postgres://new:distinctive-password@new.example.org/next?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`,
  libpq: (entries: Entries) => `host=new.example.org dbname=next user=new password=distinctive-password ${entries.map(([k, v]) => `${k}='${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(" ")}`,
};
const saved = { id: "saved", name: "Prior", host: "prior.example.org", port: 5432, database: "prior", username: "prior", password: "stored-secret", ssl: false };
const overrides = { host: "override.example.org", port: 6543, database: "override", username: "override", password: "override-secret", ssl: true };
const params = { params: Promise.resolve({ id: "saved" }) };
const refusal = (name: string) => `This connection string uses the unsupported protection parameter ${name}; Dezfil supports connection fields and SSL required or not required.`;
const sslRefusal = "This URL uses an unsupported or conflicting SSL mode; use require for SSL required, or prefer, disable or allow for SSL not required.";
const rows = () => metadataDb().prepare("SELECT * FROM pg_connections ORDER BY id").all();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.cwd(), ".tmp-protections-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  closeMetadataDb(); resetSecretKeyCache();
  io.resolve.mockReset();
  io.lookup.mockReset().mockResolvedValue([{ address: "2001:4860:4860::8888", family: 6 }]);
  io.run.mockReset().mockResolvedValue(undefined);
  io.read.mockReset().mockResolvedValue({ getRowObjects: () => [{ v: "fixture-version" }] });
});
afterEach(() => { closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function request(body: unknown) {
  return testAccountRequest(new Request("http://localhost/api/connections/postgis", { method: "POST", body: JSON.stringify(body) }));
}
function seed() {
  insertConnection(testAccountScope(), saved);
  recordConnectionCheck(testAccountScope(), saved.id, { outcome: "failing", error: "Remembered failure.", checkedAt: "2026-01-02T03:04:05.000Z", serverVersion: "Prior version", postgisVersion: "Prior spatial version" });
}
function noContact() {
  expect.soft(io.resolve).not.toHaveBeenCalled();
  expect.soft(io.lookup).not.toHaveBeenCalled();
  expect.soft(io.run).not.toHaveBeenCalled();
  expect.soft(io.read).not.toHaveBeenCalled();
}
for (const [form, string] of Object.entries(forms)) {
  for (const operation of ["create", "edit"] as const) {
    describe(`${form} ${operation} protection contract through real routes`, () => {
      async function send(url: string, extra = {}) {
        if (operation === "edit") seed();
        const before = rows();
        const req = request({ name: "Candidate", url, ...extra });
        const response = operation === "create" ? await POST(req) : await PATCH(req, params);
        return { response, before };
      }
      async function refuses(entries: Entries, name: string, extra = {}) {
        const { response, before } = await send(string(entries), extra);
        noContact();
        expect.soft(response.status).toBe(400);
        expect.soft(await response.json()).toEqual({ error: { code: "invalid_request", message: refusal(name) } });
        expect.soft(rows()).toEqual(before);
      }
      for (const [name, rejected, ignored] of inventory) {
        for (const value of rejected) {
          for (const extra of [{}, overrides]) {
            it(`refuses ${name}=${value} with overrides=${Object.keys(extra).length > 0}`, () => refuses([[name, value]], name, extra));
          }
        }
        for (const value of ["", ...ignored]) {
          it(`accepts absent/ignored ${name}=${value} and fires the same contact spies`, async () => {
            const { response } = await send(string([[name, value]]));
            expect(response.status).toBe(operation === "create" ? 201 : 200);
            expect(io.resolve).toHaveBeenCalledWith("new.example.org");
            expect(io.lookup).toHaveBeenCalledOnce(); expect(io.read).toHaveBeenCalledTimes(2);
            const attachments = io.run.mock.calls.filter(([sql]) => String(sql).startsWith("ATTACH "));
            expect(attachments).toHaveLength(1);
            expect(attachments[0][0]).toContain("hostaddr=''2001:4860:4860::8888''");
            expect(attachments[0][0]).toContain(operation === "create" ? "sslmode=require " : "sslmode=prefer ");
            expect(attachments[0][0]).not.toContain(`${name}=`);
          });
        }
        if (rejected.length) {
          for (const permissive of ["", ...ignored]) {
            for (const reverse of [false, true]) {
              const entries: Entries = [[name, rejected[0]], [name, permissive]];
              if (reverse) entries.reverse();
              it(`refuses repeated ${name} with ${permissive || "empty"}, reverse=${reverse}`, () => refuses(entries, name));
            }
          }
        }
      }
      it.each(["require", "prefer"])("refuses supplied trust with sslmode=%s", (mode) => refuses([["sslmode", mode], ["sslrootcert", "/private/root.pem"]], "sslrootcert"));
      it.each([
        ["Channel_Binding", "require", "channel_binding"],
        ["SSLROOTCERT", "/distinctive/root.pem", "sslrootcert"],
        ["ChAnNeL_BiNdInG", "PREFER", "channel_binding"],
      ])("refuses mixed-case protection name %s with canonical copy", (key, value, canonical) => refuses([[key, value]], canonical, overrides));
      it.each([false, true])("cannot hide a mixed-case occurrence with a permissive repeat, reverse=%s", (reverse) => {
        const entries: Entries = [["Channel_Binding", "require"], ["channel_binding", "prefer"]];
        if (reverse) entries.reverse();
        return refuses(entries, "channel_binding");
      });
      it("names the first mixed-case refusal", () => refuses([["GssEncMode", "require"], ["CHANNEL_BINDING", "require"]], "gssencmode"));
      it("retains empty and permissive values with mixed-case names", async () => {
        const { response } = await send(string([["SSLROOTCERT", ""], ["Channel_Binding", "prefer"]]));
        expect(response.status).toBe(operation === "create" ? 201 : 200);
        expect(io.resolve).toHaveBeenCalledWith("new.example.org");
        expect(io.read).toHaveBeenCalledTimes(2);
      });
      it.each([false, true])("preserves SSL refusal priority, reverse=%s", async (reverse) => {
        const entries: Entries = [["channel_binding", "require"], ["sslmode", "verify-full"]];
        if (reverse) entries.reverse();
        const { response, before } = await send(string(entries), overrides);
        noContact(); expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { code: "invalid_request", message: sslRefusal } });
        expect(rows()).toEqual(before);
      });
      it.each([false, true])("names the first refused parameter, reverse=%s", (reverse) => {
        const entries: Entries = [["channel_binding", "require"], ["gssencmode", "require"]];
        if (reverse) entries.reverse();
        return refuses(entries, reverse ? "gssencmode" : "channel_binding");
      });
      it("cannot hide values through URI encoding or key-value quoting and escaping", async () => {
        const url = form === "uri"
          ? "postgres://new:distinctive-password@new.example.org/next?%63hannel_binding=%72equire&channel_binding="
          : "host=new.example.org dbname=next user=new password=distinctive-password CHANNEL_BINDING='re\\quire' channel_binding=''";
        const { response, before } = await send(url, overrides);
        noContact(); expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { code: "invalid_request", message: refusal("channel_binding") } });
        expect(rows()).toEqual(before);
      });
      it("accepts valid explicit fields and emits the chosen SSL setting", async () => {
        const { response } = await send(string([["channel_binding", "prefer"], ["sslmode", "disable"]]), overrides);
        expect(response.status).toBe(operation === "create" ? 201 : 200);
        const attachment = io.run.mock.calls.find(([sql]) => String(sql).startsWith("ATTACH "))![0];
        expect(attachment).toContain("host=''override.example.org''");
        expect(attachment).toContain("sslmode=require ");
      });
      if (form === "uri") {
        it.each([
          ["/next?application_name=a#b&channel_binding=require", "channel_binding"],
          ["/next#x?sslrootcert=/distinctive/root.pem", "sslrootcert"],
          ["/next?channel_binding=prefer#require", "channel_binding"],
          ["/next?application_name=a#b&Channel_Binding=require&channel_binding=prefer", "channel_binding"],
          ["/next?application_name=a#b&gssencmode=require&channel_binding=require", "gssencmode"],
          ["/next?channel_bi\nnding=require", "channel_binding"],
          ["/next?application_name=a#b&channel_bi\nnding=require", "channel_binding"],
        ])("cannot hide protection parameters behind a hash in %s", async (suffix, name) => {
          const { response, before } = await send(`postgres://new:distinctive-password@new.example.org${suffix}`, overrides);
          noContact();
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: { code: "invalid_request", message: refusal(name) } });
          expect(rows()).toEqual(before);
        });
        it.each([
          "/next?application_name=a#b&sslmode=disable",
          "/next#fragment?sslmode=verify-full",
          "/next?SSLMODE=verify-full",
          "/next?application_name=a%23b&channel_binding=prefer",
          "/next?channel_binding=pre\nfer",
        ])("retains connection fields and SSL defaults for %s", async (suffix) => {
          const { response } = await send(`postgres://new:distinctive-password@new.example.org${suffix}`);
          expect(response.status).toBe(operation === "create" ? 201 : 200);
          expect(await response.json()).toMatchObject({ host: "new.example.org", database: "next", username: "new", ssl: operation === "create" });
          const attachment = io.run.mock.calls.find(([sql]) => String(sql).startsWith("ATTACH "))![0];
          expect(attachment).toContain(operation === "create" ? "sslmode=require " : "sslmode=prefer ");
        });
        it("retains SSL refusal priority before a hash", async () => {
          const { response, before } = await send("postgres://new:distinctive-password@new.example.org/next?sslmode=verify-full#x&channel_binding=require", overrides);
          noContact();
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: { code: "invalid_request", message: sslRefusal } });
          expect(rows()).toEqual(before);
        });
      }
    });
  }
}
it("previously stored fields remain usable, and a name-only edit makes no contact", async () => {
  seed();
  expect((await PATCH(request({ name: "Renamed" }), params)).status).toBe(200);
  noContact();
  expect((await TEST(request({}), params)).status).toBe(200);
  expect(io.resolve).toHaveBeenCalledWith("prior.example.org");
  expect(io.read).toHaveBeenCalledTimes(2);
});
