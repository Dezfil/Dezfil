import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, op, pathParam } from "./openapi-helpers";
import { LOCAL_DELETE } from "./operation-mcp";
import { resource, writes } from "./operation-metadata";

export function publicationAccess<T extends Parameters<typeof op>[0]>(config: T): T {
  return { ...config, description: "The token retains the map owner's dataset scope independently of visitor credentials, including while the owner is deactivated. Before first-account setup, a legacy token has only its pending-adoption publication scope; setup retires that scope atomically. Revocation is checked after asynchronous work before returning results. The projection never exposes account identity, private SQL, dataset paths or connection credentials. " + (config.description ?? "") };
}
export const PUBLICATION_ADMIN_PATHS = {
  "/api/publications/{token}": {
    delete: { ...op({
      summary: "Revoke a deactivated owner's publication",
      description: "Requires a current admin through a cookie session or bearer token. Revokes only the supplied token when its owner is currently deactivated, checked in the same transaction as current admin authority. An active owner's token, an unknown token and a revoked token receive identical not_found responses with no change. This operation never reads or returns private map content or account identity, and grants no other access. Deactivation alone leaves existing links available; reactivation restores the owner's private access. Responses, including refusals, are private, no-store. Cookie mutations require the same trusted Origin.",
      tag: "Publish", tool: "revoke_inactive_publication", relevance: [], mcp: LOCAL_DELETE,
      effects: writes(resource("publications", "token")),
      display: { verb: "Revoked publication {subject}", subject: { resource: "publications", argument: "token" } },
      confirm: true,
      confirmation: { target: "Revoke {target}?", consequence: "The public link will stop working.", subject: { path: null, argument: "token", name: "" } },
      parameters: [pathParam("token", "The known publication token to revoke. This operation does not discover private maps.")],
      responses: { "204": { description: "Publication revoked. No content is returned." }, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE },
    }), security: AUTH_SECURITY },
  },
};
