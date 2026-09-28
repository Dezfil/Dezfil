/** Resolve a copied package's credential reference at connection time only.
 * @param {{url: string, tokenEnv: string}} connection
 * @param {Record<string, string | undefined>} environment
 * @param {typeof fetch} fetchImpl */
export function packageFetch(connection, environment = process.env, fetchImpl = fetch) {
  const secret = environment[connection.tokenEnv];
  if (typeof secret !== 'string' || !secret || /\s/.test(secret)) throw new Error('Set DEZFIL_API_TOKEN in the client environment before connecting.');
  const origin = new URL(connection.url).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password) throw new Error('The client request is outside its configured instance.');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete('cookie'); headers.set('authorization', `Bearer ${secret}`);
    const response = await fetchImpl(input, { ...init, headers, credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error('The configured instance redirected the request.');
    }
    return response;
  };
}
