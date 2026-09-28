import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { USERS_PATHS } from "./openapi-users";
import { AUTH_SECURITY } from "./openapi-auth";
import { buildTools } from "@/lib/tools/tools";
it("generates every admin operation with current-authority and consequence metadata", () => {
  const names = [];
  for (const methods of Object.values(USERS_PATHS)) for (const operation of Object.values(methods)) {
    expect(operation.security).toEqual(AUTH_SECURITY); expect(operation.description).toContain("current admin");
    expect(operation.description).toContain("private, no-store");
    for (const status of ["401", "403", "409"]) expect(operation.responses).toHaveProperty(status);
    const tool = buildTools().find(tool => tool.name === operation["x-tool"])!;
    // Pin the intended effects independently of the document used to generate tools.
    expect(tool.effects).toEqual(tool.name === "list_users" ? { readOnly: true, writes: [] } : {
      readOnly: false, writes: [{ resource: "accounts", collection: true,
        ...(tool.name === "invite_user" ? { result: "account.id" } : { argument: "id" }) }],
    });
    expect(tool.confirm).toBe(!tool.effects.readOnly); names.push(tool.name);
  }
  expect(names.sort()).toEqual(["invite_user", "issue_user_sign_in_link", "list_users", "update_user_access"]);
});
it("documents deactivated duplicate recovery and one-time seven-day hand-over without account read secrets", () => {
  const doc = buildOpenApiDocument();
  expect(doc.components.schemas.UserInvitationConflict.properties.error.properties).toHaveProperty("canReactivate");
  expect(doc.components.schemas.UserInvitationConflict.properties.error.properties).toHaveProperty("accountId");
  expect(doc.components.schemas.IssuedSignInLink.required).toContain("expiresAt");
  expect(doc.components.schemas.Account.properties).not.toHaveProperty("signInUrl");
  expect(doc.components.schemas.Account.properties).not.toHaveProperty("password");
  expect(USERS_PATHS["/api/users"].post.description).toContain("seven days");
  expect(USERS_PATHS["/api/users/{id}"].patch.description).toContain("Self-deactivation");
  expect(USERS_PATHS["/api/users/{id}/sign-in-link"].post.description).toContain("API tokens stay valid");
});
