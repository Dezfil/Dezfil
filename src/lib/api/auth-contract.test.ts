import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { AUTH_PATHS, AUTH_SECURITY } from "./openapi-auth";
import { isEntryRequest } from "@/lib/auth/request-policy";

it("documents each authentication operation with matching security and a deliberate transport exclusion", () => {
  const doc = buildOpenApiDocument();
  for (const [path, methods] of Object.entries(AUTH_PATHS)) for (const [method, operation] of Object.entries(methods)) {
    expect(operation["x-tool"]).toBe(false);
    expect(operation.security).toEqual(isEntryRequest(path, method.toUpperCase()) ? [] : AUTH_SECURITY);
    expect(doc.paths).toHaveProperty(path);
  }
  expect(doc.components.securitySchemes.CookieSession).toMatchObject({ in: "cookie", name: "dezfil_session" });
  expect(doc.components.securitySchemes.BearerToken).toMatchObject({ type: "http", scheme: "bearer" });
});
it("documents every entry refusal and its retry fields without exposing password material in account reads", () => {
  const doc = buildOpenApiDocument();
  for (const code of ["authentication_required", "invalid_credentials", "account_deactivated", "weak_password", "setup_complete", "invalid_link", "forbidden", "ingress_unavailable", "rate_limited"]) {
    expect(doc["x-error-codes"]).toHaveProperty(code);
  }
  expect(doc.components.schemas.Error.properties.error.properties).toHaveProperty("retryAt");
  expect(doc.components.schemas.Error.properties.error.properties).toHaveProperty("retryAfter");
  expect(Object.keys(doc.components.schemas.Account.properties)).not.toContain("password");
  expect(AUTH_PATHS["/api/auth/sign-in"].post.responses["429"].headers).toHaveProperty("Retry-After");
});
