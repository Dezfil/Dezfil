import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { AccountScope } from "@/lib/auth/scope";
import { admitResourceWork, inDeletionWork } from "@/lib/auth/account-deletion-work";
import { trackInflight } from "@/lib/query/inflight";
import { openPrivateExport } from "./private-file";
interface Copy { path: string; filename: string; contentType: string; cleanup(): Promise<void> }
/** The lease follows the actual stream and observed file cleanup, including
 * aborted delivery. A path returned by preparation is not a completed read. */
export async function streamPrivateCopy(scope: AccountScope, resources: Parameters<typeof admitResourceWork>[1],
  prepare: () => Promise<Copy>, signal?: AbortSignal): Promise<NextResponse> {
  const lease = admitResourceWork(scope, resources);
  let file: Copy | undefined, handle: Awaited<ReturnType<typeof openPrivateExport>>["handle"] | undefined;
  try {
    file = await inDeletionWork(lease, prepare);
    const opened = await openPrivateExport(scope, file); handle = opened.handle;
    lease.assertCommit();
    const stream = handle.createReadStream(), copy = file;
    const abort = () => stream.destroy();
    const settled = new Promise<void>((resolve, reject) => {
      stream.once("close", () => {
        signal?.removeEventListener("abort", abort);
        copy.cleanup().then(() => { lease.release(); resolve(); }, error => { lease.release(error); reject(error); });
      });
    });
    void trackInflight(settled).catch(error => console.error("[export] stream cleanup failed:", error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, { headers: {
      "content-type": file.contentType, "content-length": String(opened.size),
      "content-disposition": `attachment; filename="${file.filename}"`,
    } });
  } catch (error) {
    try { await handle?.close(); await file?.cleanup(); }
    finally { lease.release(); }
    throw error;
  }
}
