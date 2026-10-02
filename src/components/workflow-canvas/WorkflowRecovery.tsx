"use client";
import { createContext, useContext, useState, useSyncExternalStore, type ComponentType } from "react";
import type { WorkflowDocument } from "./workflow-document";
import type { PageRead } from "./workflow-read";

export interface WorkflowRecoveryProps { recoverySeed?: PageRead; onRecovered?: (seed: PageRead) => void }
export const CanvasRecoveryContext = createContext<{ document: WorkflowDocument; recover: () => Promise<void> } | null>(null);
const subscribeNever = () => () => {};
const never = () => false;
export function useCanvasRecovery() {
  const recovery = useContext(CanvasRecoveryContext);
  const stale = useSyncExternalStore(recovery?.document.subscribe ?? subscribeNever, recovery?.document.snapshot ?? never, never);
  return { ...recovery, stale };
}
export function withWorkflowRecovery<P extends object>(Editor: ComponentType<P & WorkflowRecoveryProps>) {
  return function WorkflowRecovery(props: P) {
    const [recovery, setRecovery] = useState<{ seed: PageRead; version: number } | null>(null);
    return <Editor {...props} key={recovery?.version ?? 0} recoverySeed={recovery?.seed}
      onRecovered={seed => setRecovery(current => ({ seed, version: (current?.version ?? 0) + 1 }))} />;
  };
}
