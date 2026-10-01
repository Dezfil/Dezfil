import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { ACCOUNT_PATHS } from "./openapi-account";
import { AUTH_SECURITY } from "./openapi-auth";
import { buildTools } from "@/lib/tools/tools";

it("publishes the six own-account operations with explicit credential, effects and tool contracts", () => {
  const doc = buildOpenApiDocument();
  const names = [];
  for (const [path, methods] of Object.entries(ACCOUNT_PATHS)) for (const operation of Object.values(methods)) {
    expect(doc.paths).toHaveProperty(path);
    expect(operation.security).toEqual(AUTH_SECURITY);
    expect(operation.description).toContain("private, no-store");
    for (const status of ["400", "401", "403", "503"]) expect(operation.responses).toHaveProperty(status);
    const tool = buildTools().find(tool => tool.name === operation["x-tool"]);
    expect(tool).toBeDefined();
    // Pin the intended effects independently of the document used to generate tools.
    expect(tool?.effects).toEqual(["get_account", "list_api_tokens"].includes(tool!.name)
      ? { readOnly: true, writes: [] }
      : { readOnly: false, writes: [{ resource: "accounts", collection: true }] });
    names.push(operation["x-tool"]);
  }
  expect(names.sort()).toEqual(["change_password", "create_api_token", "get_account", "list_api_tokens", "revoke_api_token", "update_account"]);
  for (const name of ["change_password", "create_api_token", "revoke_api_token"]) {
    const tool = buildTools().find(tool => tool.name === name)!;
    expect(tool.confirm).toBe(true); expect(tool.confirmation?.consequence).toBeTruthy();
  }
});
it("documents one-time token disclosure, ownership and atomic current-password refusals", () => {
  const schemas = buildOpenApiDocument().components.schemas;
  expect(schemas.CreatedApiToken.properties).toHaveProperty("secret");
  expect(schemas.ApiToken.properties).not.toHaveProperty("secret");
  expect(schemas.Account.properties).not.toHaveProperty("password");
  expect(ACCOUNT_PATHS["/api/account"].patch.description).toContain("current_password_required");
  expect(ACCOUNT_PATHS["/api/account"].patch.description).toContain("before any write");
  expect(ACCOUNT_PATHS["/api/account/tokens/{id}"].delete.responses).toHaveProperty("404");
  expect(ACCOUNT_PATHS["/api/account/password"].post.description).toContain("ends your other sessions");
  const doc = buildOpenApiDocument();
  expect(Object.keys(doc.paths)).toHaveLength(123);
  expect(Object.values(doc.paths).flatMap(Object.keys)).toHaveLength(162);
  expect(Object.keys(doc.components.schemas)).toHaveLength(153);
});
