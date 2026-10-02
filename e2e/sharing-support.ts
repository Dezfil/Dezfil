import { captureBasis, fixtureHeaders } from "../scripts/revision-fixtures.mjs";
// People and shared projects for the sharing specs, arranged through the API.
// Each spec makes its own people, invited by the browser fixture's admin with
// a tag no other spec uses, so specs share one scratch store without meeting.
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";

export const PASSWORD = "field notebooks at dawn";
export const NOT_FOUND = "The requested resource was not found.";
export const PERMISSION = { error: { code: "forbidden", message: "You can view this but cannot make this change." } };

export interface Person {
  id: string;
  name: string;
  email: string;
  sqlName: string;
  context: BrowserContext;
  api: APIRequestContext;
}

/** A tag for this spec's run: its people, projects and datasets carry it. */
export const runTag = () => randomUUID().replaceAll("-", "").slice(0, 6);

/** An ordinary account invited by the fixture admin and signed in in a
 * context of its own. Its display name is `<first> <tag>`, so its SQL name
 * is `<first>_<tag>` in lower case. */
export async function invitePerson(browser: Browser, admin: APIRequestContext, baseURL: string, first: string, tag: string): Promise<Person> {
  const name = `${first} ${tag}`;
  const email = `${first.toLowerCase()}-${tag}@example.test`;
  const invitation = await admin.post("/api/users", { data: { name, email } });
  expect(invitation.status()).toBe(201);
  const link = new URL((await invitation.json()).signInUrl);
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin } });
  const redeemed = await context.request.post("/api/auth/redeem", {
    data: { secret: new URLSearchParams(link.hash.slice(1)).get("secret"), password: PASSWORD },
  });
  expect(redeemed.status()).toBe(200);
  const account = (await (await context.request.get("/api/account")).json()).account;
  expect(account.sqlName).toBe(`${first.toLowerCase()}_${tag}`);
  return { id: account.id, name, email, sqlName: account.sqlName, context, api: context.request };
}

/** A dataset of one row whose sentinel says whose it is. */
export async function uploadSentinel(person: Person, name: string, sentinel: string): Promise<{ id: string; name: string }> {
  const response = await person.api.post("/api/tables", { multipart: { file: {
    name: `${name}.csv`, mimeType: "text/csv", buffer: Buffer.from(`sentinel,lon,lat\n${sentinel},13.4,52.5\n`),
  } } });
  expect(response.status()).toBe(201);
  return response.json();
}

export async function createMapWithLayer(person: Person, mapName: string, layers: { name: string; sql: string }[]): Promise<{ id: string; layers: string[] }> {
  const map = await person.api.post("/api/maps", { data: { name: mapName } });
  expect(map.status()).toBe(201);
  const createdMap = await map.json();
  const id = createdMap.id as string;
  let basis = captureBasis(createdMap);
  const ids: string[] = [];
  for (const layer of layers) {
    const created = await person.api.post(`/api/maps/${id}/layers`, { data: layer, headers: fixtureHeaders(basis) });
    expect(created.status(), await created.text()).toBe(201);
    const accepted = await created.json();
    basis = captureBasis(accepted);
    ids.push(accepted.id);
  }
  return { id, layers: ids };
}

export async function createProject(person: Person, name: string, members: { addMaps?: string[]; addRecipes?: string[]; addTables?: string[] } = {}): Promise<string> {
  const response = await person.api.post("/api/projects", { data: { name, members } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id;
}

export async function share(owner: Person, projectId: string, person: Person, role: "viewer" | "editor"): Promise<void> {
  const response = await owner.api.put(`/api/projects/${projectId}/people/${person.sqlName}`, { data: { role } });
  expect(response.status(), await response.text()).toBe(200);
}

/** A hidden resource answers exactly as one that never existed. */
export async function expectAbsentAlike(api: APIRequestContext, hiddenUrl: string, missingUrl: string): Promise<void> {
  const hidden = await api.get(hiddenUrl), missing = await api.get(missingUrl);
  expect(hidden.status()).toBe(404);
  expect(await hidden.json()).toEqual(await missing.json());
}

export async function closeAll(people: (Person | undefined)[]): Promise<void> {
  for (const person of people) await person?.context.close();
}
