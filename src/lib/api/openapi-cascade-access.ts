import { ERROR_RESPONSE, type op } from "./openapi-helpers";
export function cascadeAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Workflow runs, member attempts and retained outputs follow their workflow: everyone who reaches it reads its runs, with output links out of the caller's reach left out. Planning and starting a run stay the workflow owner's until a run's outputs are its runner's own; anyone else who may run it is refused with forbidden before anything is planned. A run is cancelled by its initiator or the workflow's owner. Administrators reach nothing more. Every referenced step and run must belong to the addressed workflow; unreached, missing and mixed-parent references return not_found before planning or execution. Account activity is checked after planning, at worker entry and at publication. Deactivation prevents further admission and publication, drains admitted work and retains already committed outputs and terminal attempts. Results remain owned after step or output deletion and independent job-history pruning. Restart marks unfinished runs interrupted without executing them again. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
