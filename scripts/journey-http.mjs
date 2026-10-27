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

/** `send`, but every exchange takes a connection of its own. The MCP client
 * compiles a tool's output schema just before the tool's first call, which on
 * a busy machine holds the event loop past the server's five-second keep-alive;
 * a kept-alive connection the server closed meanwhile would then carry the
 * call, and the call would get no answer.
 * @param {(url: any, init?: any) => Promise<Response>} [send]
 * @returns {(url: string | URL | Request, init?: RequestInit) => Promise<Response>} */
export function ownConnection(send = fetch) {
  return (url, init = {}) => {
    const headers = new Headers(url instanceof Request ? url.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    headers.set('connection', 'close');
    return send(url, { ...init, headers });
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
