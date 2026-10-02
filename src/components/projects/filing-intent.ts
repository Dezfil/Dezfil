import { membersFor, producersOf, type DependencyWire, type FilingSelection, type FilingSubject } from "./add-model";

export type FilingBases = Record<string, string>;
export interface MembershipIntent {
  members: { addMaps?: string[]; removeMaps?: string[]; addRecipes?: string[]; removeRecipes?: string[]; addTables?: string[]; removeTables?: string[] };
  bases: FilingBases;
}

export function subjectBasis(subject: FilingSubject): FilingBases {
  return subject.kind !== "dataset" && subject.editRevision
    ? { [`${subject.kind}:${subject.id}`]: subject.editRevision } : {};
}

export function filingIntent(subject: FilingSubject, deps: DependencyWire[], selection: FilingSelection): MembershipIntent {
  const bases = subjectBasis(subject);
  for (const producer of producersOf(subject, deps)) {
    if (producer.owned && selection.workflows.has(producer.id) && producer.editRevision) {
      bases[`workflow:${producer.id}`] = producer.editRevision;
    }
  }
  return { members: membersFor(subject, deps, selection), bases };
}

/** Keep the captured bases at the transport boundary. The compound input
 * field ships with its enforcing route; the current contract accepts only
 * member ids. No transport read may replace these displayed bases. */
export function membershipBody(intent: MembershipIntent): MembershipIntent["members"] {
  return intent.members;
}
