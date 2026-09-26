export type PostgisPaneStepKind =
  | "loading"
  | "pick"
  | "form"
  | "browse"
  | "data_done"
  | "layer_done";

export type ConnectionLoadDestination = "preserve" | "pick" | "form";

/** Where a completed connection-list read sends the pane. */
export function connectionLoadDestination(
  current: PostgisPaneStepKind,
  connectionCount: number,
): ConnectionLoadDestination {
  if (current === "data_done" || current === "layer_done") return "preserve";
  return connectionCount > 0 ? "pick" : "form";
}
