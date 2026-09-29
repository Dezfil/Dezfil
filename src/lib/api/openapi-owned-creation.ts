import { op } from "./openapi-helpers";

/** Creation assigns ownership from authentication, never submitted fields. */
export function ownedCreationOp(config: Parameters<typeof op>[0]) {
  return op({ ...config, description:
    "Created resources belong to the authenticated account. Submitted owner identities cannot assign or transfer ownership. " +
    (config.description ?? ""),
  });
}
