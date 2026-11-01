import { afterEach, expect, it, vi } from "vitest";
import { StorageWriter, fenceStorageWriters, storageWritersState } from "./storage-fence";
import { admitTrustedOperation, withTrustedOperation } from "@/lib/trusted-operation";
import { receiveUpload } from "@/lib/ingest/receive";
import { readdir } from "node:fs/promises";
import path from "node:path";

afterEach(() => { vi.restoreAllMocks(); expect(storageWritersState()).toEqual({ fenced: false, live: 0 }); });
it("stops trusted work before releasing recovery space and refuses new writers until release", async () => {
  const started = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  let stopped = false;
  const operation = admitTrustedOperation({ kind: "import", name: "Conversion" });
  const pending = operation.run(async owner => {
    owner.onStop(() => { stopped = true; });
    started.resolve(); await settle.promise;
  }).catch(error => error);
  await started.promise;
  let fenced = false;
  const fencing = fenceStorageWriters().then(result => { fenced = true; return result; });
  expect(stopped).toBe(true);
  expect((await pending).code).toBe("storage_exhausted");
  expect(() => admitTrustedOperation({ kind: "export", name: "Export" })).toThrow(/storage is full/);
  expect(fenced).toBe(false);
  expect(await withTrustedOperation({ kind: "interactive-read", name: "Read" }, async () => 42)).toBe(42);
  settle.resolve();
  const fence = await fencing;
  expect(fence.overdue).toBe(0);
  expect(storageWritersState()).toEqual({ fenced: true, live: 0 });
  fence.release();
});

it("bounds settlement and keeps an overdue writer registered until it actually settles", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const writer = new StorageWriter();
  const fence = await fenceStorageWriters(5);
  expect(fence.overdue).toBe(1);
  expect(writer.signal.reason).toMatchObject({ code: "storage_exhausted" });
  expect(storageWritersState().live).toBe(1);
  writer.close(); fence.release();
});

it("settles an upload's streams and removes the partial before the fence answers", async () => {
  const fed = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from('--storage\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\nx,y\n1,2\n'));
    fed.resolve();
  } });
  const pending = receiveUpload(new Request("http://fixture.test/api/tables", {
    method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=storage" },
  } as RequestInit), "writer").catch(error => error);
  await fed.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  const fence = await fenceStorageWriters();
  expect(await pending).toMatchObject({ code: "storage_exhausted", status: 507 });
  expect(await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tmp"))).toEqual([]);
  expect(fence.overdue).toBe(0);
  fence.release();
});
