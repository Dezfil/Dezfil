import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function projectAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "A project is reached by its owner and by its people, its viewers and editors. Lists, counts and member lists cover exactly the reached projects and everything filed in them, whoever owns it, and name each project's owner and the caller's role (owner, editor or viewer). Renaming, the note and dissolution are the owner's; administrators reach nothing more. Filing or unfiling requires ownership of the project and every affected map, workflow and dataset. Unreached or missing references return the same not_found before changes or archive assembly; a reached project whose change the caller may not make returns forbidden and changes nothing. Compound changes are atomic. Deleting a project unfiles its contents without deleting artifacts or changing their owners. Exporting stays the project owner's, and export selections include only owned members. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
