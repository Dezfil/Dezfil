import { tokenFetch } from './journey-auth.mjs';
/** HTTP support for the headless API journey. Omit credentials for public reads. */
export function journeyApi(base, { token, cookie } = {}) {
  const send = token ? tokenFetch(base, token) : fetch;
  return async function api(method, pathname, { body, form, raw } = {}) {
    const init = { method, headers: cookie ? { cookie, origin: new URL(base).origin } : {}, redirect: 'manual' };
    if (form) {
      init.body = form;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await send(`${base}${pathname}`, init);
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
