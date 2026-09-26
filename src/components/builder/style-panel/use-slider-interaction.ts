"use client";

import { useRef, useState } from "react";

/** Shared direct-manipulation lifecycle for a single-value slider. */
export function useSliderInteraction<T>({
  value,
  onChange,
  onPreview,
  onCommit,
  onPreviewStart,
}: {
  value: T;
  onChange: (value: T) => void;
  onPreview?: (value: T) => void;
  onCommit?: (value: T) => Promise<boolean>;
  onPreviewStart?: () => void;
}) {
  const split = !!onPreview && !!onCommit;
  const [draft, setDraft] = useState<T | null>(null);
  const draftRef = useRef<T | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);

  const begin = () => {
    if (!split || activeRef.current) return;
    activeRef.current = true;
    generationRef.current += 1;
    onPreviewStart?.();
  };

  const preview = (next: T) => {
    if (!split) {
      onChange(next);
      return;
    }
    begin();
    draftRef.current = next;
    setDraft(next);
    onPreview(next);
  };

  const finish = async () => {
    if (!split || !activeRef.current) return;
    activeRef.current = false;
    const generation = generationRef.current;
    const finalValue = draftRef.current;
    if (finalValue === null) return;
    try {
      await onCommit(finalValue);
    } finally {
      // A second interaction may have started while persistence was pending.
      // Even an unexpected rejection must release the completed gesture.
      if (generation === generationRef.current && !activeRef.current) {
        draftRef.current = null;
        setDraft(null);
      }
    }
  };

  return {
    shown: split && draft !== null ? draft : value,
    begin,
    preview,
    finish,
  };
}
