import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { authenticateToken, createApiToken } from "./credentials";
import { securitySettings } from "./security-settings";
import { readInstanceSettings } from "../settings/read";
import { changeInstanceSettings } from "../settings/change";
import { readStoredSettings } from "../settings/store";
import { GET as config } from "@/app/api/config/route";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());

describe("longest token lifetime", () => {
  it.each(["30d", "90d"] as const)("caps stored 1y and never at %s, in the rule, offer, configuration and issued credential", async bound => {
    const days = bound === "30d" ? 30 : 90;
    const old = createApiToken(f.context, "Earlier", f.db);
    expect(old.expiresAt).toBeNull();
    for (const stored of ["1y", "never"]) {
      changeInstanceSettings(f.context, { tokenLifetimeMax: "none", "tokens.expiry": stored }, f.db);
      changeInstanceSettings(f.context, { tokenLifetimeMax: bound }, f.db);
      expect(securitySettings(f.db)).toMatchObject({ tokenExpiry: bound, tokenLifetimeMs: days * 86_400_000, rules: { "tokens.expiry": bound } });
      expect(readInstanceSettings(f.context, f.db).settings["tokens.expiry"]).toMatchObject({ value: bound, storedValue: stored,
        write: { kind: "choice", values: bound === "30d" ? ["30d"] : ["30d", "90d"] } });
      const at = Date.now();
      expect(createApiToken(f.context, "Bounded", f.db, at).expiresAt).toBe(new Date(at + days * 86_400_000).toISOString());
      const response = await config(f.request({ cookie: `dezfil_session=${f.member.secret}` }));
      expect(response.status).toBe(200);
      expect((await response.json()).rules["tokens.expiry"]).toBe(bound);
      expect(readStoredSettings(f.db)["tokens.expiry"]).toBe(stored);
      expect(authenticateToken(old.secret, f.db)?.account.id).toBe("admin");
      for (const above of ["never", "1y", ...(bound === "30d" ? ["90d"] : [])]) {
        expect(() => changeInstanceSettings(f.context, { "tokens.expiry": above, instanceName: "Must not land" }, f.db))
          .toThrow(expect.objectContaining({ code: "invalid_request", status: 400 }));
        expect(readStoredSettings(f.db).instanceName).toBeUndefined();
      }
    }
  });

  it("checks a compound write against its resulting bound and lets clearing the rule use the bound", () => {
    expect(() => changeInstanceSettings(f.context, { tokenLifetimeMax: "30d", "tokens.expiry": "90d" }, f.db))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(readStoredSettings(f.db)).not.toHaveProperty("tokenLifetimeMax");
    changeInstanceSettings(f.context, { tokenLifetimeMax: "90d", "tokens.expiry": "30d" }, f.db);
    expect(securitySettings(f.db).tokenExpiry).toBe("30d");
    changeInstanceSettings(f.context, { "tokens.expiry": null }, f.db);
    expect(securitySettings(f.db).tokenExpiry).toBe("90d");
    changeInstanceSettings(f.context, { tokenLifetimeMax: null }, f.db);
    expect(securitySettings(f.db).tokenExpiry).toBe("never");
  });

  it("obeys a locked bound and refuses changing it", () => {
    vi.stubEnv("DEZFIL_TOKEN_LIFETIME_MAX", "30d");
    expect(securitySettings(f.db).tokenExpiry).toBe("30d");
    expect(() => changeInstanceSettings(f.context, { tokenLifetimeMax: "none" }, f.db))
      .toThrow(expect.objectContaining({ code: "setting_locked", status: 409 }));
  });
});
