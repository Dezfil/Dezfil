import { afterEach, beforeEach, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { externalFixture } from "../../../test-support/external-sign-in";
import { POST as arrive } from "@/app/api/auth/external/arrive/route";
import { SESSION_COOKIE } from "@/lib/auth/http";
import { ARRIVAL_BODY_MAX_BYTES } from "@/lib/auth/external-sign-in/arrival";
let f: ReturnType<typeof externalFixture>;
beforeEach(() => { f = externalFixture(); });
afterEach(() => f.close());
it("publishes browser-only entry and a confirmed admin sign-out tool with the actual body bound", () => {
  const doc = buildOpenApiDocument();
  for (const path of ["/api/auth/external/start", "/api/auth/external/arrive"] as const) {
    expect(doc.paths[path].post.security).toEqual([]); expect(doc.paths[path].post["x-tool"]).toBe(false);
    expect(buildTools().some(tool => tool.path === path)).toBe(false);
  }
  const arrival = doc.paths["/api/auth/external/arrive"].post;
  expect((arrival.requestBody as { "x-byte-limit": number })["x-byte-limit"]).toBe(ARRIVAL_BODY_MAX_BYTES);
  for (const status of ["200", "400", "401", "403", "404", "409", "413", "429", "503"]) expect(arrival.responses).toHaveProperty(status);
  expect(buildTools().find(tool => tool.name === "sign_everyone_out")).toMatchObject({ confirm: true, effects: { readOnly: false, writes: [{ resource: "accounts", collection: true }, { resource: "assistant", collection: true }] } });
  for (const code of ["already_signed_in", "account_not_invited", "invalid_ticket", "external_sign_in_only", "token_outdated"]) {
    expect(doc["x-error-codes"]).toHaveProperty(code); expect(doc.components.schemas.Error.properties.error.properties.code.enum).toContain(code);
  }
});
it("validates a real signed-in refusal and rejects a response that loses the named account", async () => {
  const accepted = await arrive(f.request()); expect(accepted.status).toBe(200);
  const cookie = accepted.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
  const request = f.request(); request.headers.set("cookie", cookie);
  const response = await arrive(request); expect(response.status).toBe(409); const answer = await response.json();
  const doc = buildOpenApiDocument();
  const rewrite = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('"#/components/schemas/', '"#/$defs/'));
  const schema = fromJsonSchema({ ...rewrite(doc.components.schemas.ExternalArrivalConflict), $defs: rewrite(doc.components.schemas) });
  expect((await schema["~standard"].validate(answer)).issues).toBeUndefined();
  const broken = structuredClone(answer); delete broken.error.account;
  expect((await schema["~standard"].validate(broken)).issues?.length).toBeGreaterThan(0);
});
