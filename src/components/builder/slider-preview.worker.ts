/// <reference lib="webworker" />

import {
  runSliderPreviewWork,
  type SliderPreviewWork,
  type SliderPreviewWorkResult,
} from "@/lib/slider-preview";

self.onmessage = (event: MessageEvent<SliderPreviewWork>) => {
  let message: SliderPreviewWorkResult;
  try {
    message = {
      id: event.data.id,
      ok: true,
      result: runSliderPreviewWork(event.data),
    };
  } catch (error) {
    message = {
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : "Preview failed.",
    };
  }
  self.postMessage(message);
};

export {};
