// Real route handlers — the assistant's tools call these through fetch.
import { GET as tablesGet } from "@/app/api/tables/route";
import { POST as queryPost } from "@/app/api/query/route";
import { GET as mapsGet, POST as mapsPost } from "@/app/api/maps/route";
import { PATCH as mapPatch } from "@/app/api/maps/[id]/route";
import { POST as mapUndoPost } from "@/app/api/maps/[id]/undo/route";
import { POST as mapRedoPost } from "@/app/api/maps/[id]/redo/route";
import { POST as layersPost } from "@/app/api/maps/[id]/layers/route";
import { GET as layerRenderGet } from "@/app/api/layers/[id]/render/route";
import { PATCH as layerPatch } from "@/app/api/layers/[id]/route";
import { POST as fillPost } from "@/app/api/layers/[id]/fill/route";
import { POST as scalePost } from "@/app/api/layers/[id]/scale/route";
import { POST as publishPost } from "@/app/api/maps/[id]/publish/route";

/** Dispatch a self-call to the real route handler (the subset the journey
 * touches). Mirrors Next.js routing: path params arrive as a Promise. */
export async function dispatchAssistantJourney(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const method = req.method.toUpperCase();
  let m: RegExpMatchArray | null;

  if (pathname === "/api/tables" && method === "GET") return tablesGet(req);
  if (pathname === "/api/query" && method === "POST") return queryPost(req);
  if (pathname === "/api/maps" && method === "GET") return mapsGet(req);
  if (pathname === "/api/maps" && method === "POST") return mapsPost(req);
  if ((m = pathname.match(/^\/api\/maps\/([^/]+)$/)) && method === "PATCH") {
    return mapPatch(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/maps\/([^/]+)\/undo$/)) && method === "POST") {
    return mapUndoPost(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/maps\/([^/]+)\/redo$/)) && method === "POST") {
    return mapRedoPost(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/maps\/([^/]+)\/layers$/)) && method === "POST") {
    return layersPost(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/layers\/([^/]+)\/render$/)) && method === "GET") {
    return layerRenderGet(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/layers\/([^/]+)$/)) && method === "PATCH") {
    return layerPatch(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/layers\/([^/]+)\/fill$/)) && method === "POST") {
    return fillPost(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/layers\/([^/]+)\/scale$/)) && method === "POST") {
    return scalePost(req, { params: Promise.resolve({ id: m[1] }) });
  }
  if ((m = pathname.match(/^\/api\/maps\/([^/]+)\/publish$/)) && method === "POST") {
    return publishPost(req, { params: Promise.resolve({ id: m[1] }) });
  }
  throw new Error(`No test route for ${method} ${pathname}`);
}

export const assistantJourneyFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const request = input instanceof Request ? input : new Request(url, init);
  return dispatchAssistantJourney(request);
};
