import { authenticateDelegation } from "@/lib/auth/delegation";

const PRIVATE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Accept only short-lived delegations and rebuild headers on every request,
 * including redirects. Never put the caller's credential into page state or
 * a browser-wide header setting. */
export function renderRequestHeaders(
  requestUrl: string,
  appOrigin: string,
  credential: string,
  incoming: Record<string, string>,
): Record<string, string> | null {
  let url: URL;
  try { url = new URL(requestUrl); } catch { return null; }
  if (url.username || url.password) return null;
  try { if (!authenticateDelegation(credential)) return null; } catch { return null; }
  const headers = Object.fromEntries(Object.entries(incoming).filter(([name]) => !PRIVATE_HEADERS.has(name.toLowerCase())));
  if (url.origin === appOrigin) headers.authorization = `Bearer ${credential}`;
  return headers;
}
