"use client";

import { createContext, useContext } from "react";
import type { NodeMember } from "./graph";
import type { WorkflowRunner } from "./use-workflow-run";

/** The workflow's runs, for the panel and the host. */
export const RunContext = createContext<WorkflowRunner | null>(null);

export function useRunner(): WorkflowRunner {
  const runner = useContext(RunContext);
  if (!runner) throw new Error("useRunner needs a RunContext provider");
  return runner;
}

/** The panel's run actions, owned by the host: a node's own run, a run
 * from a node (the screen asks first when it is wide), and the refusal
 * each node's section shows. */
export interface RunActions {
  runNode: (member: NodeMember) => void;
  runFrom: (member: NodeMember) => void;
  refusalFor: (stepId: string) => { message: string; retry: (() => void) | null } | null;
  dismissRefusal: (stepId: string) => void;
}

export const RunActionsContext = createContext<RunActions | null>(null);

export function useRunActions(): RunActions {
  const actions = useContext(RunActionsContext);
  if (!actions) throw new Error("useRunActions needs a RunActionsContext provider");
  return actions;
}
