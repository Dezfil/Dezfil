import { ERROR_RESPONSE, type op } from "./openapi-helpers";
export function cascadeAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Workflow plans, runs, member attempts and retained outputs are private to the workflow owner, including for administrators. Every referenced step and run must belong to the addressed workflow; hidden, missing and mixed-parent references return not_found before planning or execution. Account activity is checked after planning, at worker entry and at publication. Deactivation prevents further admission and publication, drains admitted work and retains already committed outputs and terminal attempts. Results remain owned after step or output deletion and independent job-history pruning. Restart marks unfinished runs interrupted without executing them again. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
