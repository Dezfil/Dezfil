import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A picture whose processing runs past its deadline is refused at once,
 * while the work it abandoned winds down: the account's work lease and the
 * received file are kept until that work has settled, then let go. Any
 * other refusal is answered only once the received file is gone.
 */

const calls = vi.hoisted(() => ({ released: 0, removed: [] as string[], settle: () => {}, failure: null as (() => Error) | null }));

vi.mock("@/lib/auth/scope", () => ({ requireAccountScope: () => "ada" }));
vi.mock("@/lib/ingest/receive", () => ({ receiveUpload: async () => ({ tmpPath: "/scratch/tmp/upload-1" }) }));
vi.mock("@/lib/ingest/file-ownership", () => ({
  removeAccountFile: async (path: string) => { calls.removed.push(path); },
}));
vi.mock("./store", () => ({
  admitPictureWrite: () => ({ run: <T>(work: () => Promise<T>) => work(), release: () => { calls.released += 1; } }),
  publishPicture: async () => { throw new Error("nothing is published in these cases"); },
}));
vi.mock("./normalize", () => ({
  normalizePicture: () => {
    const settled = new Promise<void>(resolve => { calls.settle = resolve; });
    const picture = Promise.reject(calls.failure!());
    void picture.catch(() => undefined);
    return { picture, settled };
  },
}));

const { setOwnPicture } = await import("./own");
const { processingTimeout, unsupportedImage } = await import("./limits");
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { calls.released = 0; calls.removed = []; calls.failure = () => processingTimeout(20_000); });
afterEach(() => { calls.settle(); });

it("answers the timeout before the abandoned work settles, keeping the lease and the file until it does", async () => {
  const answer = setOwnPicture({} as never, new Request("http://instance.test/api/account/picture", { method: "PUT" }));
  const outcome = await Promise.race([answer.then(() => "answered", () => "refused"), flush().then(() => flush()).then(() => "waiting")]);
  expect(outcome).toBe("refused");
  await expect(answer).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(calls.released).toBe(0);
  expect(calls.removed).toEqual([]);

  calls.settle();
  await flush(); await flush();
  expect(calls.removed).toEqual(["/scratch/tmp/upload-1"]);
  expect(calls.released).toBe(1);
});

it("answers any other refusal only once the received file is gone", async () => {
  calls.failure = () => unsupportedImage("An SVG is not kept.");
  const answer = setOwnPicture({} as never, new Request("http://instance.test/api/account/picture", { method: "PUT" }));
  const outcome = await Promise.race([answer.then(() => "answered", () => "refused"), flush().then(() => flush()).then(() => "waiting")]);
  expect(outcome).toBe("waiting");
  expect(calls.removed).toEqual([]);

  calls.settle();
  await expect(answer).rejects.toMatchObject({ code: "unsupported_image" });
  expect(calls.removed).toEqual(["/scratch/tmp/upload-1"]);
  await flush();
  expect(calls.released).toBe(1);
});
