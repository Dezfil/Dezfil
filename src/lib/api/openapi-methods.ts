import { HTTP_METHODS } from "./http-methods";
import { READ_ONLY } from "./operation-metadata";
import { ERROR_RESPONSE, op } from "./openapi-helpers";

type Operation = { tags?: string[]; parameters?: unknown[]; responses: Record<string, unknown> };
/** Describe automatic methods explicitly, without adding route handlers or tools. */
export function withAutomaticMethods<T extends { paths: Record<string, object> }>(document: T): T {
  document = { ...document, paths: structuredClone(document.paths) };
  for (const item of Object.values(document.paths)) {
    const methods = item as Record<string, unknown> & { get?: Operation; head?: Operation; options?: Operation };
    if (methods.get && !methods.head) {
      methods.head = op({ summary: "Read response headers", tag: methods.get.tags?.[0] ?? "System", tool: false,
        description: "Automatic HEAD uses GET with no response body.", effects: READ_ONLY,
        parameters: methods.get.parameters,
        responses: Object.fromEntries(Object.entries(methods.get.responses).map(([status, response]) => {
          const headers = { ...response as { content?: unknown; description?: string } };
          delete headers.content;
          return [status, headers];
        })),
      });
    }
    const operations = Object.entries(methods).filter(([method]) => HTTP_METHODS.has(method)) as [string, Operation][];
    const allow = [...new Set([...operations.map(([method]) => method.toUpperCase()), "OPTIONS"])].sort().join(", ");
    const headers = { Allow: { description: "Exactly the documented methods for this path.", schema: { type: "string", const: allow } } };
    methods.options = op({ summary: "Read allowed methods", tag: "System", tool: false,
      description: "Automatic OPTIONS returns no body and the Allow header. Authentication is required.", effects: READ_ONLY,
      parameters: methods.get?.parameters?.filter(parameter => (parameter as { in?: string }).in === "path") ??
        operations[0]?.[1].parameters?.filter(parameter => (parameter as { in?: string }).in === "path"),
      responses: { "204": { description: "Allowed methods.", headers } },
    });
    for (const [method, operation] of [...operations, ["options", methods.options] as const]) {
      operation.responses["405"] = method === "head"
        ? { description: "Unsupported method. HEAD has no response body.", headers }
        : { ...ERROR_RESPONSE, description: "method_not_allowed: the method is unsupported for this path.", headers };
    }
  }
  return document;
}
