import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { derivationProbe } from "../../../scripts/derivation-probe.mjs";
import { assertAuthenticationBusy, assertDerivationSamples } from "../../../scripts/derivation-probe-support.mjs";
import * as setup from "@/app/api/auth/setup/route";
import * as signIn from "@/app/api/auth/sign-in/route";
import * as redeem from "@/app/api/auth/redeem/route";
import * as entry from "@/app/api/auth/entry/route";
import * as account from "@/app/api/account/route";
import * as password from "@/app/api/account/password/route";
import * as tokens from "@/app/api/account/tokens/route";
import * as users from "@/app/api/users/route";
const native = vi.hoisted(() => ({ active: 0, observe: (_phase: string, _elapsed?: number) => {} }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  scrypt: (_password: string, _salt: Buffer, _length: number, _options: unknown, callback: (error: Error | null, key: Buffer) => void) => {
    native.active++; native.observe("start"); const start = performance.now();
    setTimeout(() => { native.active--; native.observe("end", performance.now() - start); callback(null, Buffer.alloc(32)); }, 5);
  },
}));
it("drives the image probe through every real credential handler with observed synthetic native work", async () => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "derivation-probe-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); const db = metadata.open(path.join(directory, "metadata.sqlite")); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  const log = path.join(directory, "derivations.ndjson"); writeFileSync(log, "");
  const context = new AsyncLocalStorage<{ tag?: string; source?: string }>();
  const observe = (phase: string, elapsedMs?: number) => {
    const state = (process as unknown as Record<symbol, { active: number; activeProtected: number; ordinary: unknown[]; protected: unknown[] }>)[Symbol.for("dezfil.password-derivations")];
    appendFileSync(log, JSON.stringify({ phase, elapsedMs, cost: 131072, ...context.getStore(), nativeActive: native.active,
      admission: state ? { active: state.active, activeProtected: state.activeProtected, ordinary: state.ordinary.length, protected: state.protected.length } : null }) + "\n");
  };
  native.observe = observe;
  const routes: Record<string, Record<string, (request: Request) => Promise<Response>>> = {
    "/api/auth/entry": entry, "/api/auth/setup": setup, "/api/auth/sign-in": signIn, "/api/auth/redeem": redeem,
    "/api/account": account, "/api/account/password": password, "/api/account/tokens": tokens, "/api/users": users,
  };
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await derivationProbe("http://instance.test", { stateLog: log,
      requestImpl: async (base: string, pathname: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) => context.run({ tag: headers["x-dezfil-test-derivation"], source: headers["x-forwarded-for"] }, async () => {
        const request = socketRequest(new Request(base + pathname, { method, headers, body }), headers["x-forwarded-for"]);
        const response = await routes[pathname][method](request); const text = await response.text();
        observe("response");
        return { status: response.status, json: text ? JSON.parse(text) : null, text,
          headers: { ...Object.fromEntries(response.headers), ...(response.headers.getSetCookie().length ? { "set-cookie": response.headers.getSetCookie() } : {}) } };
      }),
    });
    expect(result.busy).toBeGreaterThan(0); expect(result.timing.nativePeak).toBe(2); expect(result.timing.protectedPeak).toBe(1);
    printed.mockRestore(); console.log(JSON.stringify({ label: "confirmed", scope: "route handlers and probe assertions, synthetic native work; no sockets or timing claim", checks: result.checks }));
  } finally { native.observe = () => {}; vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
it("rejects an admission bypass, missing observation, and a non-contract busy answer", () => {
  expect(() => assertDerivationSamples([])).toThrow();
  expect(() => assertDerivationSamples([{ phase: "start", nativeActive: 3, tag: "other-route", admission: { active: 2, activeProtected: 1, ordinary: 6, protected: 2 } }])).toThrow();
  expect(() => assertDerivationSamples([{ phase: "start", nativeActive: 1, tag: "other-route", admission: { active: 0, activeProtected: 0, ordinary: 0, protected: 0 } }])).toThrow();
  expect(() => assertAuthenticationBusy({ status: 503, headers: {}, json: { error: { code: "authentication_busy" } } })).toThrow();
});
