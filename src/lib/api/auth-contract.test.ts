import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { AUTH_PATHS, AUTH_SECURITY } from "./openapi-auth";
import { USERS_PATHS } from "./openapi-users";
import { isEntryRequest } from "@/lib/auth/request-policy";

it("documents each authentication operation with matching security and a deliberate transport exclusion", () => {
  const doc = buildOpenApiDocument();
  for (const [path, methods] of Object.entries(AUTH_PATHS)) for (const [method, operation] of Object.entries(methods)) {
    expect(operation["x-tool"]).toBe(false);
    expect(operation.security).toEqual(isEntryRequest(path, method.toUpperCase()) ? [] : AUTH_SECURITY);
    expect(doc.paths).toHaveProperty(path);
  }
  expect(doc.components.securitySchemes.CookieSession).toMatchObject({ in: "cookie", name: "dezfil_session" });
  expect(doc.components.securitySchemes.CookieSession.description).toContain("On a listening port other than 3000 the name carries the port suffix, and DEZFIL_SESSION_COOKIE sets the name.");
  expect(doc.components.securitySchemes.BearerToken).toMatchObject({ type: "http", scheme: "bearer" });
  for (const scheme of Object.values(doc.components.securitySchemes)) {
    expect(scheme.description).toContain("X-Dezfil-Account");
    expect(scheme.description).toContain("never supplies identity or changes ownership");
  }
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

it("documents the public General entry values without promising navigation", () => {
  const doc = buildOpenApiDocument();
  const schema = doc.components.schemas.AuthEntry;
  expect(schema.required).toEqual(["instanceName", "signInMessage", "lostPasswordContact", "landingPage", "passwordMin", "setupRequired"]);
  expect(schema.properties).toMatchObject({
    signInMessage: { type: "string", maxLength: 280, default: "" },
    passwordMin: { type: "integer", minimum: 8, maximum: 64 },
    lostPasswordContact: { type: "string", maxLength: 120, default: "" },
    landingPage: { type: "string", enum: ["home", "projects", "maps", "workflows", "data", "sql"], default: "home" },
  });
  const description = AUTH_PATHS["/api/auth/entry"].get.description;
  expect(description).toContain("sign-in message");
  expect(description).toContain("lost-password contact");
  expect(description).toContain("landing page");
  expect(description).toContain("shortest password");
  expect(description).toContain("does not change navigation");
  expect(description).not.toContain("Only the instance name");
});

it("names the instance's setting and its default wherever a session's or a link's lifetime is described", () => {
  const doc = buildOpenApiDocument();
  const cookie = doc.components.securitySchemes.CookieSession.description;
  expect(cookie).toContain("security.sessionDays, thirty days by default");
  for (const description of [
    AUTH_PATHS["/api/auth/redeem"].post.description,
    USERS_PATHS["/api/users"].post.description,
    USERS_PATHS["/api/users/{id}/sign-in-link"].post.description,
  ]) expect(description).toContain("security.linkDays, seven days by default");
  // Local recovery's link is not the instance's to change.
  expect(AUTH_PATHS["/api/auth/redeem"].post.description).toContain("fifteen-minute link");
  expect(JSON.stringify(doc)).not.toMatch(/Thirty days, rolling|expiring in seven days|expires seven days after issue|expires after seven days/);
});
