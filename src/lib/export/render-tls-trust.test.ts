import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { provisionTrust } from '../../../scripts/render-tls-trust.mjs';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, '', '')),
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(), writeFile: vi.fn(), chmod: vi.fn(), readFile: vi.fn().mockResolvedValue('fixture CA'),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([undefined, 'PKCS11'])('provisions both NSS stores with compatible trust despite inherited %s', async inherited => {
  vi.stubEnv('NSS_TRUST_TYPE', inherited);
  const originalPath = process.env.PATH;
  await provisionTrust('/mock-trust');
  const calls = vi.mocked(execFile).mock.calls.filter(([file, args]) => file === 'certutil' && ['-N', '-A'].includes(args?.[0] ?? ''));
  expect(calls.map(([, args]) => args?.slice(0, 3))).toEqual([
    ['-N', '-d', 'sql:/mock-trust/legacy-nss'], ['-A', '-d', 'sql:/mock-trust/legacy-nss'],
    ['-N', '-d', 'sql:/mock-trust/current-nss'], ['-A', '-d', 'sql:/mock-trust/current-nss'],
  ]);
  for (const [, , options] of calls) {
    expect(options).toMatchObject({ cwd: '/mock-trust', timeout: 30_000, env: { NSS_TRUST_TYPE: 'NSS', PATH: originalPath } });
  }
  expect(process.env.NSS_TRUST_TYPE).toBe(inherited);
});
