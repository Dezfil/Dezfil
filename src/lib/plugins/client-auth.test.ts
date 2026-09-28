import { expect, it, vi } from 'vitest';
import { packageFetch } from '../../../scripts/dezfil-client-auth.mjs';
const connection = { url: 'http://127.0.0.1:3398/api/mcp', tokenEnv: 'DEZFIL_API_TOKEN' };
it.each([undefined, '', 'bad\nheader'])('refuses a missing or malformed token before connection: %s', token => {
  const fetcher = vi.fn();
  expect(() => packageFetch(connection, { DEZFIL_API_TOKEN: token }, fetcher)).toThrow('Set DEZFIL_API_TOKEN');
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps credentials in request headers and confines each request to the configured origin', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const transport = packageFetch(connection, { DEZFIL_API_TOKEN: 'fixture-secret' }, fetcher);
  await transport(connection.url, { method: 'POST', headers: { cookie: 'untrusted', authorization: 'Bearer untrusted' } });
  const init = fetcher.mock.calls[0][1]!;
  expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', cache: 'no-store' });
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-secret');
  expect(new Headers(init.headers).has('cookie')).toBe(false);
  for (const url of ['http://localhost:3398/api/mcp', 'http://127.0.0.1:3399/api/mcp', 'https://127.0.0.1:3398/api/mcp', 'http://user@127.0.0.1:3398/api/mcp']) await expect(transport(url)).rejects.toThrow('outside');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses a redirect without issuing a follow-up request', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: 'http://trap.test/private' } }));
  await expect(packageFetch(connection, { DEZFIL_API_TOKEN: 'fixture-secret' }, fetcher)(connection.url)).rejects.toThrow('redirected');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
