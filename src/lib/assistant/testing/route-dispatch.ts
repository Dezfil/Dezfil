/// <reference types="vite/client" />
import { authenticatedRequest } from "./account";
import { socketRequest } from "./socket-request";
// Test-only loopback routing. All handlers are the shipped routes, loaded only
// when requested. A live model has the same documented tool catalogue as a
// scripted model; an unexpected tool does not silently become a fake result.
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const modules = import.meta.glob("/src/app/api/**/route.ts") as Record<string, () => Promise<Record<string, Handler>>>;
const routes = Object.entries(modules).map(([file, load]) => {
  const keys: string[] = [];
  const pattern = file.replace("/src/app", "").replace("/route.ts", "").split("/").map((part) => {
    if (part.startsWith("[") && part.endsWith("]")) { keys.push(part.slice(1, -1)); return "([^/]+)"; }
    return part;
  }).join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys, load };
}).sort((a, b) => a.keys.length - b.keys.length);
export async function dispatchAssistantTestRoute(request: Request): Promise<Response> {
  request = new URL(request.url).pathname.startsWith("/api/assistant") ? authenticatedRequest(request) : socketRequest(request);
  const pathname = new URL(request.url).pathname;
  for (const route of routes) {
    const matched = pathname.match(route.pattern);
    if (!matched) continue;
    const handlers = await route.load();
    const handler = handlers[request.method];
    if (!handler) return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
    return handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(matched[i + 1])]))) });
  }
  throw new Error(`No real fixture route for ${request.method} ${pathname}`);
}
