import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, op, pathParam } from "./openapi-helpers";
import { LOCAL_DELETE } from "./operation-mcp";
import { resource, writes } from "./operation-metadata";

export function publicationAccess<T extends Parameters<typeof op>[0]>(config: T): T {
  return { ...config, responses: { ...config.responses, "503": { ...ERROR_RESPONSE, description: "ingress_unavailable: The instance cannot serve published maps yet. Private, no-store; refused before body work or publication resolution." }, "429": { ...ERROR_RESPONSE, description: "rate_limited: Too many requests. Please slow down." } }, description: "Verified ingress source is charged before token resolution, including unknown tokens. The five view operations, the satellite style among them, share one source budget across tokens (default 60 per ten seconds); tiles, the satellite tiles among them, have a separate budget (default 600). Missing or forged provenance answers 503 ingress_unavailable. The combined state holds at most 10,000 entries, expired on traffic then evicted least recently used; eviction grants a fresh window. Untrusted proxies share their socket budget. Every address of one IPv6 /64 is charged to one budget; an IPv4 source is charged alone, whether mapped, reaching the instance through the NAT64 prefix 64:ff9b::/96, or neither. The token evaluates the map's SQL in its SQL home with the map owner's current reach, independently of visitor credentials, including while the owner is deactivated, restricted to the datasets the map's own layers name: nothing else of the owner's space is mounted for the link. A layer or widget that reads the instance's catalogue fails with catalogue_not_published while the owner holds datasets the map does not name, and one naming a dataset the owner can no longer reach fails with sql_error. Before first-account setup, a legacy token has only its pending-adoption publication scope; setup retires that scope atomically. Revocation is checked after asynchronous work before returning results. The projection never exposes account identity, private SQL, dataset paths or connection credentials. " + (config.description ?? "") };
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
