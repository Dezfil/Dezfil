"use client";

import { ErrorNote } from "../../ui/ErrorNote";
import { layerFailureCopy } from "../layer-failure";

/**
 * The style panel's failure presentation, extracted from the panel per
 * the decomposition habit.
 *
 * The errored-render note is the documented carve-out's face — the one
 * surface where raw engine text reaches an author — and the engine text
 * rides behind the note's disclosure rather than inline: the lead
 * sentence is the catalogue's, the diagnostic is one click deeper. The
 * note carries no retry or dismiss because it states a standing
 * condition, not an event: it clears when the layer's SQL renders again,
 * and the remedy lives in the layer's source editor. A dataset the
 * author cannot reach is the exception: its sentence is the product's
 * own, naming the dataset as written, so it leads the note on its own.
 *
 * A channel failure (a classify or scale write the server rejected)
 * describes a completed attempt, so it dismisses.
 */
export function PanelFailureNotes({
  renderError,
  channelError,
  onDismissChannelError,
}: {
  renderError: { code: string; message: string } | null;
  channelError: string | null;
  onDismissChannelError: () => void;
}) {
  const copy = renderError ? layerFailureCopy(renderError, "author") : null;
  return (
    <>
      {copy && (
        <ErrorNote
          message={copy.message}
          detail={copy.detail}
          data-render-error
        />
      )}
      {channelError && (
        <ErrorNote
          message={channelError}
          onDismiss={onDismissChannelError}
        />
      )}
    </>
  );
}
