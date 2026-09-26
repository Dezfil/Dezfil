"use client";
import { useRef } from "react";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import { useTheme } from "../../theme";
import { builderContext } from "./builder-context";
import { AssistantPane, useAssistantShell } from "./AssistantShell";
import type { PageFacts } from "./talking-about";
import type { HelperSlotControl } from "../use-helper-slot";

export function useBuilderAssistant(mapId: string, selectedLayerId: string | null, slot: HelperSlotControl) {
  const popRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const shell = useAssistantShell(toggleRef, slot);
  const { theme } = useTheme();
  const context = builderContext(mapId, selectedLayerId, theme);
  return { ...shell, popRef, toggleRef, context };
}
export function BuilderAssistantPane({ assistant, overlay, onMutate, layerDataDownloads, facts }: {
  assistant: ReturnType<typeof useBuilderAssistant>;
  overlay: boolean;
  onMutate: () => void;
  layerDataDownloads: LayerDataDownloadPort;
  facts?: PageFacts;
}) {
  return <AssistantPane {...assistant} overlay={overlay} onClose={() => assistant.setOpen(false)}
    onMutate={onMutate} layerDataDownloads={layerDataDownloads} facts={facts} />;
}
