import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function workflowAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "A workflow is reached by its owner and, while it is filed in a project, by that project's owner and people; its steps, layout and runs follow it. Results name the workflow's owner and SQL home and are read in that home within the caller's own reach: a reference the caller cannot reach is missing to them, named as written, and recorded lineage, output links and captured layer identities out of their reach are left out. Content changes are open to the owner, the project's owner and its editors; deletion and duplication stay the owner's. Administrators reach nothing more. Unreached or missing workflows, steps, captured layers and project references return not_found before reading private contents or changing resources; a reached workflow whose change the caller may not make returns forbidden and changes nothing. Output-name conflicts and duplicate-name allocation consider only the caller's own datasets and the workflow's declarations, preserving the existing same-workflow conflict rules. Accepted changes recheck account activity and referenced-resource access at commit. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
