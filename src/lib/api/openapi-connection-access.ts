import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function connectionAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Connections are private to the authenticated account, including for administrators. Names are unique only within that account. Hidden or missing connection references return not_found before reading credentials, contacting the source or changing stored health. Imports and refreshes recheck connection ownership and account activity before committing. Snapshots and their project memberships include only the caller's datasets. A project grant never reaches a connection: one behind a dataset shared with the caller is listed, browsed, tested and used by nobody but its owner, answering not_found as one that does not exist; refreshing such a dataset is its owner's act alone; no operation transfers a connection. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
