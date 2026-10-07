"use client";

import type { MapWithLayers } from "@/lib/metadata/maps";
import type { AssistantDoorProps } from "./assistant/AssistantDoor";
import { BuilderAssistantPane, useBuilderAssistant } from "./assistant/BuilderAssistant";
import type { PageFacts } from "./assistant/talking-about";
import { RecipeDrawerHost, useBuilderStage } from "./drawer/host";
import type { LayerDataDownloadPort } from "./use-layer-data-downloads";

/**
 * The builder's helpers, composed out of `MapBuilder.tsx` (the
 * decomposition rule at the touch): Tools left of the stage and the
 * assistant right of it, the slot's rules between them, the two stage
 * edges the camera frames against, and the door the header mounts. The
 * builder reads three things from here and should not need to know how
 * they relate: the edges for its camera padding, the door's props for
 * its header, and the one component that mounts both helpers.
 */
export function useBuilderHelpers(mapId: string, selectedLayerId: string | null) {
  const { drawer, slot, stageEdges } = useBuilderStage();
  const assistant = useBuilderAssistant(mapId, selectedLayerId, slot);
  const door: AssistantDoorProps = {
    open: slot.assistantVisible,
    triggerRef: assistant.toggleRef,
    triggerProps: assistant.triggerProps,
    onToggle: slot.toggleAssistant,
  };
  return { drawer, slot, stageEdges, assistant, door };
}

export function BuilderHelpers({
  helpers,
  map,
  selectedLayerId,
  onWorkspaceChange,
  onLayerMade,
  onMutate,
  layerDataDownloads,
}: {
  helpers: ReturnType<typeof useBuilderHelpers>;
  map: MapWithLayers | null;
  selectedLayerId: string | null;
  /** A run changed the workspace: the builder reads it again. */
  onWorkspaceChange: () => void;
  /** A run created this layer, and the builder selects it. */
  onLayerMade: (layerId: string) => void;
  /** An assistant action changed the map: the builder reads it again. */
  onMutate: () => void;
  layerDataDownloads: LayerDataDownloadPort;
}) {
  const { drawer, slot, assistant } = helpers;
  // The chips' facts: the loaded map's name and the selected layer's,
  // the same identities the context carries.
  const facts: PageFacts | undefined = map
    ? { page: "builder", mapName: map.name, selectedLayerName: map.layers.find((layer) => layer.id === selectedLayerId)?.name ?? null }
    : undefined;
  return (
    <>
      <RecipeDrawerHost
        state={drawer}
        map={map}
        selectedLayerId={selectedLayerId}
        onWorkspaceChange={onWorkspaceChange}
        onLayerMade={onLayerMade}
        overlay={slot.overlay}
        hidden={drawer.open && !slot.toolsVisible}
      />
      <BuilderAssistantPane
        assistant={assistant}
        overlay={slot.overlay}
        onMutate={onMutate}
        layerDataDownloads={layerDataDownloads}
        facts={facts}
      />
    </>
  );
}
