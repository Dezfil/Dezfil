import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { ABSENT_KIND_HEADER, absentKindOfFolder } from "@/lib/absent-kind";
import { addressDataset } from "@/lib/dataset-address";
import { readTemplateForAddress } from "@/lib/templates/catalogue";
import { privateResponse } from "./http";
import { canReach } from "./reach";
import type { AccountScope } from "./scope";
import { requireRequestScope } from "./scope-http";

/** The workspace pages that show one map, workflow, project, dataset or
 * template, by the address they serve. */
const DETAIL_PAGE = /^\/(maps|workflows|projects|tables|templates)\/([^/]+)\/?$/;

/** An address no page answers. A folder whose name starts with an
 * underscore is private to the app's source and never a route. */
export const NO_PAGE = "/_absent";

/**
 * Whether the page at this address shows a resource the account reaches
 * nothing at: one that does not exist, or one it may not see, which the
 * API answers exactly as a missing one. Every other address is not this
 * check's to judge, and a read that fails for another reason leaves the
 * page to say so.
 */
export async function pageFindsNothing(scope: AccountScope, pathname: string): Promise<boolean> {
  const match = DETAIL_PAGE.exec(pathname);
  if (!match) return false;
  let address: string;
  try { address = decodeURIComponent(match[2]); } catch { return false; }
  switch (match[1]) {
    case "maps": return !canReach(scope, "map", address);
    case "workflows": return !canReach(scope, "workflow", address);
    case "projects": return !canReach(scope, "project", address);
    case "tables": return answersAbsent(() => addressDataset(scope, address));
    default: return answersAbsent(() => readTemplateForAddress(address));
  }
}

async function answersAbsent(read: () => unknown): Promise<boolean> {
  try {
    await read();
    return false;
  } catch (error) {
    return error instanceof ApiError && error.status === 404;
  }
}

/**
 * The gate's answer to a signed-in request for a page that shows one
 * resource, served as an address no page answers when the person reaches
 * nothing there. The framework's own not-found then answers it, as it
 * answers an unknown address: the 404 status and the whole workspace
 * document, the person's look and theme on it. The workspace holds its
 * pages out of the server render until the browser has confirmed the
 * session, so a page's own not-found never reached the render that sets
 * the status. The kind of item travels with the request, so the page can
 * say what was not found. The gate's cookie and privacy headers go with the
 * answer.
 */
export async function withPagePresence(request: Request, gate: Response): Promise<Response> {
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  if (request.method !== "GET" && request.method !== "HEAD") return gate;
  const pathname = new URL(request.url).pathname;
  if (!DETAIL_PAGE.test(pathname)) return gate;
  try {
    if (!(await pageFindsNothing(requireRequestScope(request), pathname))) return gate;
  } catch {
    // The page authenticates again and answers whatever went wrong here.
    return gate;
  }
  const headers = new Headers(request.headers);
  const kind = absentKindOfFolder(DETAIL_PAGE.exec(pathname)![1]);
  if (kind) headers.set(ABSENT_KIND_HEADER, kind);
  const absent = privateResponse(NextResponse.rewrite(new URL(NO_PAGE, request.url), { request: { headers } }));
  for (const cookie of gate.headers.getSetCookie()) absent.headers.append("set-cookie", cookie);
  return absent;
}
