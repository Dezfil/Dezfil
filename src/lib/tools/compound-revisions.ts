import type { InputSchema } from "./input-schema";

/** The body schema declares compound document preconditions. The assistant
 * owns their values just as it owns the single-document revision header. */
export function compoundRevisionPath(schema: InputSchema): "members" | "self" | undefined {
  if (schema.properties.expectedRevisions) return "self";
  const members = schema.properties.members as InputSchema | undefined;
  if (members?.properties?.expectedRevisions) return "members";
}
export function withoutCompoundRevision(schema: InputSchema, path: "members" | "self"): InputSchema {
  if (path === "members") return { ...schema, properties: { ...schema.properties,
    members: withoutCompoundRevision(schema.properties.members as InputSchema, "self") } };
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => name !== "expectedRevisions"));
  return { ...schema, properties, ...(schema.required ? { required: schema.required.filter(name => name !== "expectedRevisions") } : {}) };
}
