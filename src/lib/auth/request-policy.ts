const ENTRY_METHODS: Readonly<Record<string, readonly string[]>> = {
  "/api/auth/entry": ["GET", "HEAD"], "/api/auth/setup": ["POST"],
  "/api/auth/sign-in": ["POST"], "/api/auth/redeem": ["POST"],
  "/setup": ["GET", "HEAD"], "/sign-in": ["GET", "HEAD"], "/accept": ["GET", "HEAD"],
};
export function isEntryRequest(pathname: string, method: string): boolean {
  return ENTRY_METHODS[pathname]?.includes(method) ?? false;
}
/** Exact anonymous operation shapes also govern the OpenAPI security declarations. */
export function isAnonymousOperation(pathname: string, method: string): boolean {
  if (isEntryRequest(pathname, method)) return true;
  if (pathname === "/api/health") return method === "GET" || method === "HEAD";
  if (/^\/v\/[^/]+$/.test(pathname)) return method === "GET" || method === "HEAD";
  if (/^\/api\/published\/[^/]+$/.test(pathname)) return method === "GET" || method === "HEAD";
  if (/^\/api\/published\/[^/]+\/(?:extent|render)\/[^/]+$/.test(pathname) ||
      /^\/api\/published\/[^/]+\/widget-values$/.test(pathname)) return method === "POST";
  if (/^\/api\/published\/[^/]+\/tiles\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/.test(pathname)) return method === "GET" || method === "HEAD";
  return false;
}

export function isAdminRequest(pathname: string): boolean {
  return pathname === "/users" || pathname === "/api/users" || pathname.startsWith("/api/users/");
}
