const count = (key: string) => ({
  type: "object", additionalProperties: false, required: ["key", "limit", "count"],
  properties: { key: { const: key }, limit: { type: "integer", minimum: 0, description: "Zero means no limit." }, count: { type: "integer", minimum: 0 } },
});

export const INSTANCE_LIMITS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["maps", "projects", "people", "tokenLifetimeMax"],
  description: "Limits in force and instance-wide counts, across every owner. Maps include duplicates and template copies; installed templates do not count. " +
    "People include invited, active, deactivated and deleting accounts and readable unfinished deletion journals, each identity once, even after profile erasure. " +
    "A completed deletion and its retained identity do not count. Lowering a limit deletes nothing and only refuses new creations; other actions remain available.",
  properties: { maps: count("mapsLimit"), projects: count("projectsLimit"), people: count("peopleLimit"),
    tokenLifetimeMax: { type: "string", enum: ["none", "30d", "90d", "1y"], description: "The longest new token lifetime; none leaves tokens.expiry unbounded. Earlier tokens keep their expiry." } },
};

export const INSTANCE_CREATION_LIMIT = "Creation is admitted under one immediate write transaction. At the instance limit it answers 409 instance_limit_reached " +
  "with key, limit and count and creates nothing. The message names the editable setting, or its locking variable and a restart. " +
  "A zero limit is unbounded. A duplicate or template copy consumes a place, and a template copy also creates a project; a refusal rolls back the whole copy. ";

export const TOKEN_LIFETIME_BOUND_NOTE = "While tokenLifetimeMax is set, tokens.expiry reports the shorter of its stored choice and the bound. In instance settings, storedValue keeps the original choice. " +
  "Its write.values offer excludes never and every choice above the bound. New tokens take that effective lifetime; earlier tokens keep their expiry. " +
  "A submitted tokens.expiry above the resulting bound answers 400 invalid_request. Lowering the bound alone preserves the stored rule. ";
