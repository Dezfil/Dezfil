import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function projectAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Projects, their counts and their member lists belong only to the authenticated account, including for administrators. Filing or unfiling requires ownership of the project and every affected map, workflow and dataset. Hidden or missing references return the same not_found before changes or archive assembly. Compound changes are atomic. Deleting a project unfiles its contents without deleting artifacts or changing their owners. Export selections include only owned members. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
