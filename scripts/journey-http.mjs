/** HTTP support for the headless API journey. */
export function journeyApi(base) {
  return async function api(method, pathname, { body, form, raw } = {}) {
    const init = { method, headers: {} };
    if (form) {
      init.body = form;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${pathname}`, init);
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
