import type { AssistantContext } from "@/lib/assistant/context";

/** The builder page's assistant context: the map, the selected layer and
 * the resolved theme, so an automatic check renders the appearance the
 * person is looking at. */
export function builderContext(mapId: string, selectedLayerId: string | null, theme: "light" | "dark"): AssistantContext {
  return { page: "builder", mapId, selectedLayerId, appearance: theme };
}
