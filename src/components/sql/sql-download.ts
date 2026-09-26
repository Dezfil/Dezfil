import type { LayerExportFormat } from "@/lib/export/layer-export";
import { readApiError } from "../api";

/**
 * The page's download road: prepare the file on the server, then hand the
 * browser a native, streamed attachment by navigating a hidden anchor to
 * the single-use redeem URL. A failure at the prepare step stays in-app
 * as a message; no bytes pass through a whole-response blob.
 */
export async function downloadResult(
  sql: string,
  format: LayerExportFormat,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/query/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, format, name, prepare: true }),
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const { ticket, key } = (await response.json()) as {
    ticket: string;
    key: string;
  };
  const url = `/api/query/export?ticket=${encodeURIComponent(ticket)}&key=${encodeURIComponent(key)}&format=${format}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // The anchor has done its job once the navigation is dispatched.
  setTimeout(() => a.remove(), 0);
}
