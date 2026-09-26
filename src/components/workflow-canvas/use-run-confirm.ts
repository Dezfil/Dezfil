"use client";

import { useState } from "react";
import type { RunPlan, WorkflowRunner } from "./use-workflow-run";

/**
 * The start flow's one owner, extracted from the workflow screen so the
 * project home shares the identical interaction rather than growing a
 * second path: plan, ask when wide, start exactly what was confirmed; a
 * refusal is said at the action or in the dialog; a plan that changed
 * mid-confirm re-plans with the reason after the host re-reads.
 */

export interface RunFrom {
  id: string;
  label: string;
}

export interface RunRefusal {
  message: string;
  retry: (() => void) | null;
}

export interface RunConfirmState {
  plan: RunPlan;
  from: RunFrom | null;
  notice: string | null;
}

export function useRunConfirm(opts: {
  runner: Pick<WorkflowRunner, "plan" | "start">;
  /** The pre-plan guard; a sentence refuses, null proceeds. */
  guard?: () => string | null;
  /** Re-read before re-planning when the workflow changed mid-confirm,
   * so the dialog names what is there now. */
  onPlanChanged?: () => Promise<unknown>;
}): {
  confirm: RunConfirmState | null;
  refusal: RunRefusal | null;
  confirming: boolean;
  askRun: (from: RunFrom | null) => Promise<void>;
  confirmRun: () => Promise<void>;
  closeConfirm: () => void;
  dismissRefusal: () => void;
} {
  const { runner, guard, onPlanChanged } = opts;
  const [confirm, setConfirm] = useState<RunConfirmState | null>(null);
  const [refusal, setRefusal] = useState<RunRefusal | null>(null);
  const [confirming, setConfirming] = useState(false);

  const askRun = async (from: RunFrom | null) => {
    setRefusal(null);
    const guarded = guard?.() ?? null;
    if (guarded !== null) {
      setRefusal({ message: guarded, retry: null });
      return;
    }
    const plan = await runner.plan(from?.id);
    if ("refused" in plan) {
      setRefusal({ message: plan.refused, retry: null });
      return;
    }
    if (!plan.wide) {
      const outcome = await runner.start({
        fromStepId: from?.id,
        members: plan.members,
      });
      if (outcome.kind === "refused")
        // The refusal and its Retry are this owner's: Retry asks again here.
        setRefusal({
          message: outcome.message,
          retry: outcome.retryable ? () => void askRun(from) : null,
        });
      else if (outcome.kind === "save_failed")
        setRefusal({
          message: `Couldn't save the change, so nothing started. ${outcome.message}`,
          retry: null,
        });
      return;
    }
    setConfirm({ plan, from, notice: null });
  };

  const confirmRun = async () => {
    if (!confirm) return;
    setConfirming(true);
    const outcome = await runner.start({
      fromStepId: confirm.from?.id,
      members: confirm.plan.members,
    });
    setConfirming(false);
    if (outcome.kind === "started") {
      setConfirm(null);
      return;
    }
    if (outcome.kind === "refused" && outcome.code === "plan_changed") {
      // The workflow changed in between: plan again, with the reason.
      await onPlanChanged?.();
      const again = await runner.plan(confirm.from?.id);
      if ("refused" in again) setConfirm({ ...confirm, notice: again.refused });
      else setConfirm({ ...confirm, plan: again, notice: outcome.message });
      return;
    }
    setConfirm(null);
    if (outcome.kind === "refused")
      setRefusal({
        message: outcome.message,
        retry: outcome.retryable ? () => void confirmRun() : null,
      });
    else if (outcome.kind === "save_failed")
      setRefusal({
        message: `Couldn't save the change, so nothing started. ${outcome.message}`,
        retry: null,
      });
  };

  return {
    confirm,
    refusal,
    confirming,
    askRun,
    confirmRun,
    closeConfirm: () => setConfirm(null),
    dismissRefusal: () => setRefusal(null),
  };
}
