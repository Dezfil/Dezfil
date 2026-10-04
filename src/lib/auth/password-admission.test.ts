import { expect, it, vi } from "vitest";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "./passwords";
const native = vi.hoisted(() => ({ calls: [] as { options: unknown; callback: (error: Error | null, key: Buffer) => void }[] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  scrypt: (_password: string, _salt: Buffer, _length: number, options: unknown, callback: (error: Error | null, key: Buffer) => void) => native.calls.push({ options, callback }),
}));
it("admits hashing and known or dummy verification before submitting native work without changing its cost", async () => {
  const all = Array.from({ length: 8 }, (_, i) => i % 2 ? hashPassword("one careful field notebook") : verifyPassword("wrong", DUMMY_PASSWORD_HASH));
  expect(native.calls).toHaveLength(2);
  await expect(hashPassword("one careful field notebook")).rejects.toMatchObject({ code: "authentication_busy" });
  for (let i = 0; i < 8; i++) {
    expect(native.calls[i].options).toEqual({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
    native.calls[i].callback(null, Buffer.alloc(32)); await Promise.resolve(); await Promise.resolve();
  }
  await Promise.all(all);
});
