import type { AccountScope } from "@/lib/auth/scope";
import { canReach, permissionRefused } from "@/lib/auth/reach";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requireReachedTable, type ReachedTable } from "@/lib/metadata/owned-tables";
import { resolveParameter } from "@/lib/query/bindings";
import { namespaceFor } from "@/lib/query/namespace";

/**
 * A dataset as a standalone request addresses it. A bare name keeps its
 * meaning, the caller's own dataset of that name; another person's dataset is
 * addressed by its qualified name, `<sql name>.<name>`, or by its identifier.
 * The name resolves through the identity resolver in the caller's own
 * context, so it binds exactly what the caller's SQL would bind. A dataset
 * the caller cannot reach is absent, exactly as one that does not exist.
 */
export function addressDataset(scope: AccountScope, address: string): ReachedTable {
  const { resolution } = resolveParameter(namespaceFor(scope), address);
  if (resolution.status === "bound") return requireReachedTable(scope, resolution.dataset.id);
  if (canReach(scope, "dataset", address)) return requireReachedTable(scope, address);
  throw resourceAbsent();
}

/** A dataset a change addresses: the caller's own, by any of its addresses;
 * another person's dataset the caller reaches is refused by the permission
 * shape, before anything is read or changed: a dataset changes only by its
 * owner. */
export function requireOwnDataset(scope: AccountScope, address: string): ReachedTable {
  const reached = addressDataset(scope, address);
  if (reached.ownerId !== scope.accountId) throw permissionRefused();
  return reached;
}
