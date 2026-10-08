import { PROVIDER_CACHES } from "@/lib/provider-caches";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_DELETE } from "./operation-mcp";
import { resource, writes } from "./operation-metadata";

/**
 * What the services keep, as the configuration read reports it, and the
 * Clear that empties their caches.
 */

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

const cache = (service: string) => ({
  ...object({
    bytes: { type: "integer", minimum: 0, description: "Bytes the cached answers take in the data folder." },
    answers: { type: "integer", minimum: 0, description: "How many answers the cache holds." },
    budgetMb: { type: "number", minimum: 0, description: "The cache's size budget in MB, as its variable gives it; the oldest answers go first past it." },
  }),
  description: `${service}'s cached answers.`,
});

export const SERVICE_FACTS_SCHEMA = {
  ...object({
    geocode: cache("The address finder"),
    isochrone: cache("Travel time"),
    overpass: cache("OpenStreetMap"),
    overture: {
      description: "The Overture release list this process keeps: how many releases, the newest and when it was listed, or listed false before any listing succeeded. The pinned releases offered through an outage are never kept.",
      oneOf: [
        object({ listed: { const: false } }),
        object({ listed: { const: true }, releases: { type: "integer", minimum: 1 }, newest: { type: "string" }, listedAt: { type: "string", format: "date-time" } }),
      ],
    },
  }),
  description: "What the services keep on this instance, read from the data folder and this process without asking any service.",
};

export const INSTANCE_SERVICES_SCHEMAS = {
  ClearedServiceCaches: object({
    cleared: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...PROVIDER_CACHES] }, description: "The caches emptied." },
  }),
};

export const INSTANCE_SERVICES_PATHS = {
  "/api/instance/caches": { delete: { ...op({
    summary: "Clear service caches",
    description: "Requires a current admin through cookie or bearer authentication, rechecked on every call. " +
      "Cookie requests require the same trusted Origin; an admin bearer token calls directly. Responses, including refusals, are private, no-store. " +
      "Removes cached answers only: with service, that one cache (geocode for the address finder, isochrone for travel time, overpass for OpenStreetMap); " +
      "without it, all three. Settings, datasets, runs and the Overture release list are unchanged. An answer whose request began before the Clear is not kept, " +
      "and a write already landing is waited for and then removed. Clearing an empty cache answers the same. Answers with the caches cleared. " +
      "The embedded assistant asks for confirmation before calling on pages admitting writes; SQL and workflow assistants refuse this operation. " +
      "MCP advertises that policy and adds no confirmation step.",
    tag: "System", tool: "clear_service_caches", toolInput: { closed: true }, display: { verb: "Cleared service caches" },
    effects: writes(resource("caches")), mcp: LOCAL_DELETE, confirm: true,
    confirmation: { target: "Clear cached service answers?",
      consequence: "This removes cached answers only. The next request for each asks its service again; settings and data are unchanged.",
      subject: { path: null, argument: "", name: "" } },
    parameters: [{ name: "service", in: "query", required: false, schema: { type: "string", enum: [...PROVIDER_CACHES] },
      description: "The one cache to clear; omitted, all three." }],
    responses: { "200": jsonOk("#/components/schemas/ClearedServiceCaches"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
};
