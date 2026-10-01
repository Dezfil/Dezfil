import { readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";
import type { PersonLabel, ProjectPersonWire } from "./people";
import type { MemberRole } from "./share-model";

/**
 * The share dialog's calls: the directory search, a project's people, and
 * the owner's changes to them, each answered with the API's own words when
 * it refuses. The dialog is thin over these, as every surface is over the
 * API.
 */

async function call<T>(path: string, init: RequestInit | undefined, doing: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new Error(serverUnreachable(doing));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const peoplePath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/people`;
const personPath = (projectId: string, sqlName: string) =>
  `${peoplePath(projectId)}/${encodeURIComponent(sqlName)}`;

/** Active people other than oneself, by any part of their name or their
 * exact email. */
export async function findPeople(query: string): Promise<PersonLabel[]> {
  const body = await call<{ accounts: PersonLabel[] }>(
    `/api/accounts/search?q=${encodeURIComponent(query)}`,
    undefined,
    "search for people",
  );
  return body.accounts;
}

export async function readPeople(projectId: string): Promise<ProjectPersonWire[]> {
  return (await call<{ people: ProjectPersonWire[] }>(peoplePath(projectId), undefined, "read the project's people")).people;
}

/** Give a person a role on the project, adding them or changing it. */
export async function setRole(projectId: string, sqlName: string, role: MemberRole): Promise<ProjectPersonWire[]> {
  return (await call<{ people: ProjectPersonWire[] }>(personPath(projectId, sqlName), json("PUT", { role }), "change the project's people")).people;
}

export async function removePerson(projectId: string, sqlName: string): Promise<ProjectPersonWire[]> {
  return (await call<{ people: ProjectPersonWire[] }>(personPath(projectId, sqlName), json("DELETE"), "change the project's people")).people;
}

/** Make one of the project's members its owner. */
export async function transferProject(projectId: string, sqlName: string): Promise<void> {
  await call<unknown>(`/api/projects/${encodeURIComponent(projectId)}/transfer`, json("POST", { to: sqlName }), "hand the project over");
}
