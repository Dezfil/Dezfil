const ENTRY_METHODS: Readonly<Record<string, readonly string[]>> = {
  "/api/auth/entry": ["GET", "HEAD"], "/api/auth/setup": ["POST"],
  "/api/auth/sign-in": ["POST"], "/api/auth/redeem": ["POST"],
  "/setup": ["GET", "HEAD"], "/sign-in": ["GET", "HEAD"], "/accept": ["GET", "HEAD"],
};
export function isEntryRequest(pathname: string, method: string): boolean {
  return ENTRY_METHODS[pathname]?.includes(method) ?? false;
}
/** Account surfaces adopt the gate before the existing clients are switched. */
export function usesAccountGate(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/") ||
    pathname === "/api/account" || pathname.startsWith("/api/account/") ||
    isAdminRequest(pathname) ||
    ["/setup", "/sign-in", "/accept"].includes(pathname);
}

export function isAdminRequest(pathname: string): boolean {
  return pathname === "/users" || pathname === "/api/users" || pathname.startsWith("/api/users/");
}
