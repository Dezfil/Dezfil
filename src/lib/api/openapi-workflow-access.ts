import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function workflowAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Workflow definitions, steps and layouts are private to the authenticated account, including for administrators. Hidden or missing workflows, steps, captured layers and project references return not_found before reading private contents or changing resources. Output-name conflicts and duplicate-name allocation consider only that account's datasets and workflow declarations, preserving the existing same-workflow conflict rules. Accepted changes recheck account activity and referenced-resource access at commit. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
