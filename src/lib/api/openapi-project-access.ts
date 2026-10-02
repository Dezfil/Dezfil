import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** What a project named for a resource at its creation must be. */
export const FILING_DESTINATION = " It must be a project the caller owns or edits, whose owner is active: one the caller only views refuses with forbidden, and one they cannot reach refuses as an unknown one.";

export function projectAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "A project is reached by its owner and by its people, its viewers and editors. Lists, counts and member lists cover exactly the reached projects and everything filed in them, whoever owns it, and name each project's owner and the caller's role (owner, editor or viewer). Renaming, the note, dissolution, its people and its transfer are the owner's; administrators reach nothing more. Filing follows its own rules: adding a map, workflow or dataset needs the destination's permission (the project's owner, or an editor filing their own resource) and a project whose owner is active; the owner of a resource may always withdraw it from any project, member or not; the project's owner may remove anything filed in their project, which never deletes it or changes its owner. Unreached or missing references return the same not_found before changes or archive assembly; a reached project whose change the caller may not make returns forbidden and changes nothing. Compound changes are atomic. Deleting a project unfiles its contents without deleting artifacts or changing their owners. Anyone who reaches a project may export it, viewers included: a selection names members filed in it that the caller reaches, whoever owns them. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
