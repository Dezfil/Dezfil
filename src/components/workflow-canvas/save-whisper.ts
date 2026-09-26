import type { SaveState } from "./use-layout-saves";

export interface Whisper {
  owner: "rename" | "layout" | "recipe" | "import";
  text: string;
  tone?: "bad";
  action?: { label: string; run: () => void };
}

export function savedWhisper(current: Whisper | null, owner: "layout" | "recipe", failure?: SaveState | null): Whisper | null {
  if (failure?.kind === "failed") return { owner: "recipe", text: "Couldn’t save", tone: "bad", action: { label: "Retry", run: failure.retry } };
  return current === null || current.tone !== "bad" || current.owner === owner
    ? { owner, text: "Saved" }
    : current;
}
