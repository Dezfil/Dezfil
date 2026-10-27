import { tokenFetch } from './journey-auth.mjs';
import { fixtureHeaders } from './revision-fixtures.mjs';
/** `send`, but a request that gets no answer says which one it was: fetch names
 * neither the request nor the endpoint, and a JSON-RPC body names its call.
 * @param {(url: any, init?: any) => Promise<Response>} [send]
 * @returns {(url: string | URL | Request, init?: RequestInit) => Promise<Response>} */
export function named(send = fetch) {
  return async (url, init = {}) => {
    try {
      return await send(url, init);
    } catch (error) {
      let call = '';
      try {
        const message = JSON.parse(init.body);
        call = ` (${message.method}${message.params?.name ? ` ${message.params.name}` : ''})`;
      } catch { /* not a JSON-RPC body */ }
      const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
      throw new Error(`${init.method ?? url.method ?? 'GET'} ${target.pathname}${call} got no answer: ${error.cause?.message ?? error.message}`, { cause: error });
    }
  };
}

/** HTTP support for the headless API journey. Omit credentials for public reads. */
export function journeyApi(base, { token, cookie, origin } = {}) {
  const send = token ? tokenFetch(base, token) : fetch;
  return async function api(method, pathname, { body, form, raw, basis } = {}) {
    const init = { method, headers: fixtureHeaders(basis, { ...(origin ? { origin } : {}), ...(cookie ? { cookie, origin: new URL(base).origin } : {}) }), redirect: 'manual' };
    if (form) {
      init.body = form;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await named(send)(`${base}${pathname}`, init);
    if (raw) return response;
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  };
}
