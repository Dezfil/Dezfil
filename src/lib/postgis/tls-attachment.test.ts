import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

const engine = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/duckdb", () => ({
  withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) =>
    work({ run: engine.run, runAndReadAll: engine.read } as unknown as DuckDBConnection),
}));
vi.mock("@/lib/net/egress", () => ({ resolveAllowed: async () => ["192.0.2.1"] }));

import { POST } from "@/app/api/connections/postgis/route";
import { PATCH } from "@/app/api/connections/postgis/[id]/route";
import { closeMetadataDb } from "@/lib/metadata/db";
import { connectionPassword, getConnection, insertConnection } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { parseConnectionUrl } from "./connection-input";

const refusal = "This URL uses an unsupported or conflicting SSL mode; use require for SSL required, or prefer, disable or allow for SSL not required.";
const secret = "tls-distinctive-secret";
const forms = {
  uri: (modes: string[]) => `postgres://reader:${secret}@db.example.org/next?${modes.map((m) => `sslmode=${m}`).join("&")}`,
  libpq: (modes: string[]) => `host=db.example.org dbname=next user=reader password=${secret} ${modes.map((m) => `sslmode='${m}'`).join(" ")}`,
};
const saved = { id: "c1", name: "Old", host: "db.example.org", port: 5432, database: "old", username: "reader", password: "stored-secret", ssl: false };
function request(body: unknown) {
  return new Request("http://localhost/api/connections/postgis", { method: "POST", body: JSON.stringify(body) });
}
const attachments = () => engine.run.mock.calls.filter(([sql]) => String(sql).startsWith("ATTACH "));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.cwd(), ".tmp-tls-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetSecretKeyCache();
  engine.run.mockReset().mockResolvedValue(undefined);
  engine.read.mockReset().mockResolvedValue({ getRowObjects: () => [{ v: "fixture-version" }] });
});
afterEach(() => { closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

for (const [form, url] of Object.entries(forms)) {
  for (const operation of ["create", "edit-off", "edit-on"] as const) {
    const edit = operation !== "create";
    const send = async (modes: string[], extra = {}) => {
      const body = { name: "TLS test", url: url(modes), ...extra };
      if (!edit) return POST(testAccountRequest(request(body)));
      insertConnection(testAccountScope(), { ...saved, ssl: operation === "edit-on" });
      return PATCH(request(body), { params: Promise.resolve({ id: saved.id }) });
    };
    describe(`${form} ${operation} through real route and outgoing attachment`, () => {
      it.each([
        ["disable", "prefer"], ["allow", "prefer"], ["prefer", "prefer"], ["require", "require"],
      ])("maps %s to %s", async (input, expected) => {
        const response = await send([input]);
        expect(response.status).toBe(edit ? 200 : 201);
        expect(attachments()).toHaveLength(1);
        expect(attachments()[0][0]).toContain(`sslmode=${expected} `);
      });
      it.each([[], [""], ["", ""]])("retains the default for absent/empty modes %j", async (...modes) => {
        const response = await send(modes as string[]);
        expect(response.status).toBe(edit ? 200 : 201);
        expect(attachments()).toHaveLength(1);
        expect(attachments()[0][0]).toContain(`sslmode=${operation === "edit-off" ? "prefer" : "require"} `);
      });
      it.each([["verify-ca"], ["verify-full"], ["unknown"], ["prefer", "require"], ["require", "prefer"]])(
        "refuses %j before any attachment even with an SSL override", async (...modes) => {
          const response = await send(modes as string[], { ssl: false });
          // Check contact separately from the 400 so validation-after-connect seeds fail here.
          expect(attachments()).toHaveLength(0);
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: { code: "invalid_request", message: refusal } });
          if (edit) {
            expect(getConnection(saved.id)).toMatchObject({ database: "old", ssl: operation === "edit-on", status: "never_checked" });
            expect(connectionPassword(saved.id)).toBe(saved.password);
          }
        },
      );
      it("allows explicit SSL override only after validating a supported URL", async () => {
        const response = await send(["require"], { ssl: false });
        expect(response.status).toBe(edit ? 200 : 201);
        expect(attachments()[0][0]).toContain("sslmode=prefer ");
      });
    });
  }
  describe(`${form} shared parser copy`, () => {
    it("preserves the precise refusal without echoing input", () => {
      for (const mode of ["verify-ca", "verify-full", "oops"]) {
        expect(() => parseConnectionUrl(url([mode]))).toThrow(refusal);
        try { parseConnectionUrl(url([mode])); } catch (error) {
          expect(String(error)).not.toContain(secret);
          expect(String(error)).not.toContain("db.example.org");
        }
      }
    });
    it("accepts identical repeats and ignores empty options", () => {
      expect(parseConnectionUrl(url(["prefer", "prefer"])).ssl).toBe(false);
      expect(parseConnectionUrl(url(["", "require", ""])).ssl).toBe(true);
    });
  });
}
