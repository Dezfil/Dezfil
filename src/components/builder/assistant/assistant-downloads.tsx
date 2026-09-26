"use client";
import { useState } from "react";
import { readApiError } from "../../api";
import { isLayerDataFormat, layerDataFormatLabel, type LayerDataFormat } from "../export/formats";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import styles from "../AssistantPanel.module.css";

export interface ImageActionDownload {
  kind: "image";
  href: string;
  label: string;
  /** The image definition body the click re-sends. */
  post: unknown;
  filename?: string;
}

interface LayerActionDownload {
  kind: "layer";
  layerId: string;
  format: LayerDataFormat;
  label: string;
}

export type ActionDownload = ImageActionDownload | LayerActionDownload;

/** The download door for a successful file-producing call, built from the
 * call's own arguments. */
export function downloadFor(
  tool: string,
  args: Record<string, unknown>,
): ActionDownload | undefined {
  if (tool === "export_layer_data") {
    const id = args.id;
    const format = args.format;
    if (typeof id !== "string" || !isLayerDataFormat(format)) return undefined;
    return {
      kind: "layer",
      layerId: id,
      format,
      label: `Download the ${layerDataFormatLabel(format)} file`,
    };
  }
  // Image export is a POST with a definition body: the door re-runs the
  // same documented call on click and hands the blob over.
  if (tool === "export_map_image") {
    const id = args.id;
    if (typeof id !== "string") return undefined;
    return {
      kind: "image",
      href: `/api/maps/${encodeURIComponent(id)}/export/image`,
      post: { definition: args.definition },
      filename: "map.png",
      label: "Download the PNG",
    };
  }
  return undefined;
}

/** One download door: layer data joins the shared recoverable coordinator;
 * the image POST retains its existing click-run behavior. */
export function DownloadDoor({
  door,
  layerDataDownloads,
}: {
  door: ActionDownload;
  layerDataDownloads: LayerDataDownloadPort;
}) {
  const [note, setNote] = useState<string | null>(null);
  if (door.kind === "layer") {
    return (
      <button
        type="button"
        className={styles.download}
        disabled={layerDataDownloads.active(door.layerId, door.format)}
        onClick={() => layerDataDownloads.start(door.layerId, door.format)}
      >
        {door.label}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className={styles.download}
        onClick={() => {
          setNote(null);
          runPostDownload(door).catch((e) =>
            setNote(e instanceof Error ? e.message : "The download failed."),
          );
        }}
      >
        {door.label}
      </button>
      {note && <span className={styles.detail}>{note}</span>}
    </>
  );
}

/** Run a POST download door: fetch → blob → anchor click. */
async function runPostDownload(door: ImageActionDownload): Promise<void> {
  const r = await fetch(door.href, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(door.post),
  });
  // The renderer's coded errors carry actionable guidance — surface it, never a bare status.
  if (!r.ok) throw new Error(await readApiError(r));
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = door.filename ?? "download";
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

