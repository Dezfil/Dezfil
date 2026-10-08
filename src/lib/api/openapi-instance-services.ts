import { PROVIDER_CACHES } from "@/lib/provider-caches";
import { TESTED_SERVICES } from "@/lib/settings/service-test-answer";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_DELETE, REMOTE_READ } from "./operation-mcp";
import { REACHES_OUTSIDE, resource, writes } from "./operation-metadata";

/**
 * What the services keep, as the configuration read reports it, the Clear
 * that empties their caches, and each service's Test.
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

const tested = { type: "string", enum: [...TESTED_SERVICES], description: "The service tested." };
const failed = { const: "failed" };

export const INSTANCE_SERVICES_SCHEMAS = {
  ClearedServiceCaches: object({
    cleared: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...PROVIDER_CACHES] }, description: "The caches emptied." },
  }),
  ServiceTestAnswer: {
    description: "A service's Test: passed, with the milliseconds the service took to answer (Overture: how many releases its listing names and the newest), " +
      "or failed with one reason: not_set_up (no address), refused (the egress rules refused it; message is the check's sentence), unreachable (nothing answered), " +
      "timed_out (no answer within the service's time limit), status (an answer with that status) or unexpected_answer (an answer, but not as the service gives one). " +
      "Never the service's body, its address or a key.",
    oneOf: [
      object({ service: { type: "string", enum: TESTED_SERVICES.filter(service => service !== "overture") }, result: { const: "passed" },
        milliseconds: { type: "integer", minimum: 0, description: "How long the service took to answer, once the request was sent." } }),
      object({ service: { const: "overture" }, result: { const: "passed" },
        releases: { type: "integer", minimum: 1, description: "How many releases the listing names; kept as the list the Overture pane offers." },
        newest: { type: "string", description: "The newest release." } }),
      object({ service: tested, result: failed, reason: { const: "refused" }, message: { type: "string", description: "The egress check's sentence." } }),
      object({ service: tested, result: failed, reason: { const: "status" }, status: { type: "integer", minimum: 100, maximum: 599, description: "The status the service answered with." } }),
      object({ service: tested, result: failed, reason: { type: "string", enum: ["not_set_up", "unreachable", "timed_out", "unexpected_answer"] } }),
    ],
  },
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
  "/api/instance/services/{service}/test": { post: { ...op({
    summary: "Test a service",
    description: "Requires a current admin through cookie or bearer authentication, rechecked on every call. " +
      "Cookie requests require the same trusted Origin; an admin bearer token calls directly. Responses, including refusals, are private, no-store. " +
      "Sends the service one fixed request at its address in effect, never one given here: geocode (the address finder) one search for a fixed place, " +
      "isochrone (travel time) one area on foot round a fixed point for the shortest band, overpass (OpenStreetMap) the smallest Overpass query, " +
      "overture a listing of the releases, s3 one request to the S3 address's root without credentials. It goes the way the service's own requests go: " +
      "through the egress check, redirects included, and after the gap between requests for the address finder and travel time. " +
      "It reaches outside this server and stores nothing: no setting changes and no cache is read or written, except that the Overture Test keeps the " +
      "release list it finds, as Check now does. A second Test of a service while one runs gets the same answer from the same request. " +
      "A stored address the instance's key no longer opens is refused with service_address_unreadable, as the service refuses it. " +
      "The embedded assistant asks for confirmation before calling; SQL and workflow assistants refuse this operation. " +
      "MCP advertises that policy and adds no confirmation step.",
    tag: "System", tool: "test_service", toolInput: { closed: true },
    display: { verb: "Reached outside this server to test the {arg.service} service" },
    effects: REACHES_OUTSIDE, mcp: REMOTE_READ, confirm: true,
    confirmation: { target: "Send a test request to the {target} service?",
      consequence: "This server sends one request to the service at its address in effect. Nothing is saved, except that a Test of Overture keeps the release list it finds.",
      subject: { path: null, argument: "service", name: "" } },
    parameters: [{ name: "service", in: "path", required: true, schema: { type: "string", enum: [...TESTED_SERVICES] },
      description: "The service to test: geocode, isochrone, overpass, overture or s3." }],
    responses: { "200": jsonOk("#/components/schemas/ServiceTestAnswer"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
};
