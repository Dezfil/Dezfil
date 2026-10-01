import type { DuckDBConnection } from "@duckdb/node-api";
import type { Namespace, ReachableDataset } from "./bindings";
import type { EvaluationPurpose } from "./context";

/**
 * How one evaluation's namespace is mounted on its connection.
 *
 * One temporary view per dataset the evaluation can see, each dataset once:
 *
 *  - a workflow's declared outputs under their plain names, first, so a
 *    reserved output that is unavailable has no view and a reference to it
 *    fails rather than reaching a same-named home dataset;
 *  - the home's datasets under their plain names, as a single person's
 *    evaluation always mounted them;
 *  - every other owner's dataset under one quoted name, `"<sql name>.<dataset>"`.
 *
 * A qualified reference reaches its dataset through the view that dataset is
 * mounted under: the home's own `ada.roads` is the plain `roads` view where
 * nothing shadows it. Only a home dataset whose plain name a declared output
 * of another identity has taken gets a synthetic binding instead, and that is
 * never a view: the compiler gives the statement that names it a private
 * relation of its own, so catalogue discovery cannot see it. No mount is ever
 * replaced by a lower-priority one.
 */
export interface Mount {
  /** The view's name: a plain dataset name, or `<sql name>.<dataset>`. */
  view: string;
  dataset: ReachableDataset;
}

export type QualifiedBinding = { view: string } | { synthetic: ReachableDataset };

export interface MountPlan {
  namespace: Namespace;
  purpose: EvaluationPurpose;
  /** True when the evaluating account is the SQL home. */
  callerIsHome: boolean;
  /** Every view, by lower-cased view name, in registry order. */
  views: Map<string, Mount>;
  /** A lower-cased plain name to its view, or null while it is reserved. */
  plain: Map<string, string | null>;
  /** `<sql name>.<dataset>`, lower-cased, to how it is reached. */
  qualified: Map<string, QualifiedBinding>;
  /** The relation each synthetic binding reads, filled at registration. */
  synthetic: Map<string, string>;
  /** A publication's mount, when its owner's reach holds datasets the map
   * does not name: the catalogue it could discover is not the one it had. */
  withheld?: boolean;
}

export function planMounts(namespace: Namespace, purpose: EvaluationPurpose, callerIsHome: boolean): MountPlan {
  const plan: MountPlan = {
    namespace, purpose, callerIsHome,
    views: new Map(), plain: new Map(), qualified: new Map(), synthetic: new Map(),
  };
  const byId = new Map(namespace.datasets.map((dataset) => [dataset.id, dataset]));
  const viewOf = new Map<string, string>();
  const mount = (view: string, dataset: ReachableDataset) => {
    plan.views.set(view.toLowerCase(), { view, dataset });
    viewOf.set(dataset.id, view);
  };
  for (const [name, id] of namespace.outputs) {
    const dataset = id ? byId.get(id) : undefined;
    if (dataset && !viewOf.has(dataset.id)) mount(name, dataset);
    plan.plain.set(name, dataset ? viewOf.get(dataset.id)! : null);
  }
  const home = namespace.home;
  for (const dataset of namespace.datasets) {
    if (dataset.ownerId !== home.id) continue;
    const name = dataset.name.toLowerCase();
    const qualifiedName = home.sqlName ? `${home.sqlName}.${name}` : null;
    if (plan.plain.has(name)) {
      if (!qualifiedName) continue;
      plan.qualified.set(qualifiedName, viewOf.get(dataset.id) !== undefined
        ? { view: viewOf.get(dataset.id)! }
        : { synthetic: dataset });
      continue;
    }
    if (!viewOf.has(dataset.id)) mount(dataset.name, dataset);
    plan.plain.set(name, viewOf.get(dataset.id)!);
    if (qualifiedName) plan.qualified.set(qualifiedName, { view: viewOf.get(dataset.id)! });
  }
  for (const dataset of namespace.datasets) {
    if (dataset.ownerId === home.id || !dataset.ownerSqlName) continue;
    const qualifiedName = `${dataset.ownerSqlName}.${dataset.name}`.toLowerCase();
    if (!viewOf.has(dataset.id)) mount(qualifiedName, dataset);
    plan.qualified.set(qualifiedName, { view: viewOf.get(dataset.id)! });
  }
  // Mount in the registry's order, whatever order the priorities assigned
  // the names in, so a single person's evaluation mounts exactly as before.
  const order = new Map(namespace.datasets.map((dataset, index) => [dataset.id, index]));
  plan.views = new Map([...plan.views].sort(([, a], [, b]) => order.get(a.dataset.id)! - order.get(b.dataset.id)!));
  return plan;
}

/** Plans belong to the connection that mounted them, and nothing else. */
const plans = new WeakMap<DuckDBConnection, MountPlan>();
export function setMountPlan(conn: DuckDBConnection, plan: MountPlan): void {
  plans.set(conn, plan);
}
export function mountPlanOf(conn: DuckDBConnection): MountPlan | undefined {
  return plans.get(conn);
}
