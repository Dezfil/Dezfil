"use client";

import { ErrorNote } from "../ui/ErrorNote";
import {
  FAILURE_LANES,
  type FailureKey,
} from "./use-mutation-lane";
import type { LayerDataDownloadFailureView } from "./use-layer-data-downloads";
import { DownloadNotes, type ActiveDownloadNote } from "./DownloadNotes";

export function BuilderFailureNotes({
  failures,
  clearFailure,
  activeDownloads,
  downloadFailures,
}: {
  failures: Partial<Record<FailureKey, string>>;
  clearFailure: (key: FailureKey) => void;
  activeDownloads: ActiveDownloadNote[];
  downloadFailures: LayerDataDownloadFailureView[];
}) {
  const mutationKeys = [
    ...FAILURE_LANES.filter((lane) => failures[lane]),
    ...(Object.keys(failures) as FailureKey[])
      .filter((key) => key.startsWith("layer:"))
      .sort(),
  ] as FailureKey[];

  return (
    <>
      {mutationKeys.map((lane) => (
        <ErrorNote
          key={lane}
          message={failures[lane]}
          onDismiss={() => clearFailure(lane)}
          data-map-error
          data-lane={lane}
        />
      ))}
      <DownloadNotes activeDownloads={activeDownloads} downloadFailures={downloadFailures} />
    </>
  );
}
