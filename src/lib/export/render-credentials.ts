import { pictureWorkScope } from "@/lib/auth/scope";
import { PICTURE_WORK_HEADER } from "@/lib/pictures/credential";
import { authenticateDelegation } from "@/lib/auth/delegation";

const PRIVATE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-dezfil-picture-work"]);

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
  const picture = credential.startsWith("dz_picture_");
  try {
    if (picture) pictureWorkScope(credential);
    else if (!authenticateDelegation(credential)) return null;
  } catch { return null; }
  const headers = Object.fromEntries(Object.entries(incoming).filter(([name]) => !PRIVATE_HEADERS.has(name.toLowerCase())));
  if (url.origin === appOrigin) {
    if (picture) headers[PICTURE_WORK_HEADER] = credential;
    else headers.authorization = `Bearer ${credential}`;
  }
  return headers;
}
