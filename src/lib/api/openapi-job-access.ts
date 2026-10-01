import { ERROR_RESPONSE, type op } from "./openapi-helpers";
export function jobAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Standalone run records and subject histories are private to their initiating account, including for administrators. Standalone jobs retain their initiating owner before any output exists, after failure and after output deletion; contained jobs follow their workflow, read by everyone who reaches it and cancelled by their initiator or the workflow's owner. Unreached and missing run identities return not_found before cancellation or private content reads. Subject grouping, history pruning and output-name conflicts are account-local. Workers recheck account activity before preparation and at publication; an inactive owner's unfinished job fails with authentication_required and keeps no new output. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
