---
title: "API quickstart"
summary: "Create an API token, then list your maps, upload a CSV, run SQL, add a layer and publish the map, with curl or JavaScript."
read_when:
  - "you want your first working calls to the Dezfil API"
  - "you need an API token for a script or an agent"
  - "you want to upload data, run SQL, or build and publish a map from code"
  - "a call answers authentication_required, invalid_request or stale_revision"
audience:
  - developer
  - agent
checked: none
order: 1
---

- **You need:** a running Dezfil and an account on it. To run Dezfil yourself, follow [Install](../start/install.md) first. On an instance someone else runs, ask its admin for an account.
- **Data:** the 48 cities of [Your first map](../start/first-map.md#1-save-the-cities), saved as `world-cities.csv` in the folder you run the examples from.
- **Tools:** curl, or Node.js 24 or later. Save a JavaScript tab under the name in its title and run it with `node`, such as `node list-maps.mjs`.

The examples call `http://localhost:3000`; change the address if yours differs. Replace `<YOUR_TOKEN>` with your token, and a value such as `<MAP_ID>` with the one an answer before it gave. Answers are spread over lines, though curl prints each on one, and `...` stands for fields left out.

## Step 1: Create a token

1. In Dezfil, select **Settings** at the bottom of the left rail, then **API & MCP**.
2. In **API / MCP tokens**, enter a **Token name**, such as `Quickstart`, and select **Create token**.
3. Select **Copy token**, then **Done**. Dezfil shows the token only once.

You should see the new token in the list, marked **Never used**.

> [!WARNING]
> A token acts with your account's access until you revoke it or it expires. Keep it out of code you share. When you are done with it, select **Revoke** next to it, then **Revoke token**.

### Or from a script

Sign in with your email and password, then ask for a token with the session cookie that signing in gives you:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s -o /dev/null -c cookies.txt http://localhost:3000/api/auth/sign-in \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"email": "<YOUR_EMAIL>", "password": "<YOUR_PASSWORD>"}'
curl -s -b cookies.txt http://localhost:3000/api/account/tokens \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"name": "Quickstart"}'
rm cookies.txt
```
:::
:::tab[JavaScript]
```js title="create-token.mjs"
const base = "http://localhost:3000";
const json = { "Content-Type": "application/json", Origin: base };

const signIn = await fetch(`${base}/api/auth/sign-in`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ email: "<YOUR_EMAIL>", password: "<YOUR_PASSWORD>" }),
});
if (!signIn.ok) throw new Error(JSON.stringify(await signIn.json()));
const cookie = signIn.headers.getSetCookie()[0].split(";")[0];

const response = await fetch(`${base}/api/account/tokens`, {
  method: "POST",
  headers: { ...json, Cookie: cookie },
  body: JSON.stringify({ name: "Quickstart" }),
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
{
  "id": "<TOKEN_ID>",
  "name": "Quickstart",
  "createdAt": "2026-10-20T09:00:00.791Z",
  "lastUsedAt": null,
  "revokedAt": null,
  "expiresAt": null,
  "secret": "<YOUR_TOKEN>"
}
```

- `secret` is your token, the `<YOUR_TOKEN>` of the calls below. It begins with `dz_token_`, and no other answer shows it.
- `Origin` names the instance's own address. Dezfil refuses a sign-in, or a change sent with a session cookie, unless it does, so another website can't act with your session.
- `expiresAt` stays `null` unless an admin sets **New tokens expire after** in **Settings** › **Security**, as [Security and rules](../self-host/configuration/rules.md) describes.
- `-c cookies.txt` keeps the session cookie of the sign-in, whose own answer `-o /dev/null` drops, and `-b cookies.txt` sends it back. `rm cookies.txt` deletes it.

## Step 2: List your maps

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/maps \
  -H "Authorization: Bearer <YOUR_TOKEN>"
```
:::
:::tab[JavaScript]
```js title="list-maps.mjs"
const response = await fetch("http://localhost:3000/api/maps", {
  headers: { Authorization: "Bearer <YOUR_TOKEN>" },
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
[]
```

- `Authorization: Bearer` carries the token. Every call below sends it, and acts as your account.
- A new account has no maps, so the list is empty. If you made Your first map with this account, it lists that map. Later it holds every map you reach: your own, and those in projects shared with you.

## Step 3: Upload a CSV

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/tables \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -F "file=@world-cities.csv"
```
:::
:::tab[JavaScript]
```js title="upload.mjs"
import { openAsBlob } from "node:fs";

const form = new FormData();
form.append("file", await openAsBlob("world-cities.csv"), "world-cities.csv");

const response = await fetch("http://localhost:3000/api/tables", {
  method: "POST",
  headers: { Authorization: "Bearer <YOUR_TOKEN>" },
  body: form,
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
{
  "id": "<TABLE_ID>",
  "sourceFilename": "world-cities.csv",
  "format": "csv",
  ...
  "geometryColumn": "geometry",
  "geometryType": "POINT",
  ...
  "rowCount": 48,
  ...
  "name": "world_cities",
  ...
}
```

- `file` is the one form field an upload takes. To upload several files, send one request for each.
- The dataset takes its name from the file: `world-cities.csv` becomes `world_cities`. If you already have one, such as Your first map's, the new one is `world_cities_2`.
- Dezfil reads the `latitude` and `longitude` columns as each city's position, and stores the points in a new `geometry` column. [CSV columns](../use/import-data.md#csv-columns) lists the names it recognizes.

## Step 4: Run SQL

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/query \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT name, country, population FROM world_cities ORDER BY population DESC LIMIT 3"}'
```
:::
:::tab[JavaScript]
```js title="query.mjs"
const response = await fetch("http://localhost:3000/api/query", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    sql: "SELECT name, country, population FROM world_cities ORDER BY population DESC LIMIT 3",
  }),
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
{
  "columns": [
    { "name": "name", "type": "VARCHAR" },
    { "name": "country", "type": "VARCHAR" },
    { "name": "population", "type": "BIGINT" }
  ],
  "rowCount": 3,
  "preview": [
    { "name": "Tokyo", "country": "Japan", "population": "35676000" },
    { "name": "New York", "country": "United States of America", "population": "19040000" },
    { "name": "Mexico City", "country": "Mexico", "population": "19028000" }
  ],
  "previewTruncated": false,
  "runtimeMs": 4
}
```

- `sql` holds one read-only `SELECT` over your datasets. [Query with SQL](../use/sql.md) shows what it can do.
- `rowCount` counts every row of the result. `preview` holds the first rows, and `previewTruncated` is `true` when some were left out. [Limits](limits.md) gives the preview's size.
- `population` arrives as text: `BIGINT` numbers travel as strings, so no digit is lost.
- `runtimeMs` is how long the query took, so yours differs.

## Step 5: Create a map and add a layer

Create an empty map:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/maps \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name": "World cities"}'
```
:::
:::tab[JavaScript]
```js title="create-map.mjs"
const response = await fetch("http://localhost:3000/api/maps", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "World cities" }),
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
{
  "id": "<MAP_ID>",
  "name": "World cities",
  ...
  "published": false,
  ...
  "editRevision": "<MAP_REVISION>",
  ...
}
```

The `editRevision` names this state of the map. Each change to the map sends the newest one in the `X-Edit-Revision` header, and answers with the next. [Edit with revisions](http-api.md#edit-with-revisions) has the rules.

Add a layer of the cities with more than 10 million people, using the map's `id` and `editRevision`:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/maps/<MAP_ID>/layers \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "X-Edit-Revision: <MAP_REVISION>" \
  -d '{"name": "Big cities", "sql": "SELECT name, population, geometry FROM world_cities WHERE population > 10000000"}'
```
:::
:::tab[JavaScript]
```js title="add-layer.mjs"
const response = await fetch("http://localhost:3000/api/maps/<MAP_ID>/layers", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
    "X-Edit-Revision": "<MAP_REVISION>",
  },
  body: JSON.stringify({
    name: "Big cities",
    sql: "SELECT name, population, geometry FROM world_cities WHERE population > 10000000",
  }),
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
{
  "id": "<LAYER_ID>",
  "mapId": "<MAP_ID>",
  "name": "Big cities",
  "sql": "SELECT name, population, geometry FROM world_cities WHERE population > 10000000",
  "style": { ... },
  ...
  "editRevision": "<LAYER_REVISION>",
  ...
}
```

- `sql` decides what the layer draws: any query that returns a geometry column. This one keeps 15 of the 48 cities.
- Without a `style`, the layer takes the instance's default look. The [operation reference](https://dezfil.io/docs/api/reference/) lists every style field.
- The answer's `editRevision` is the map's new one. The next change sends it.

In the app, the map appears on your **Maps** page. Open it to see the 15 cities.

## Step 6: Publish the map

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s -X POST http://localhost:3000/api/maps/<MAP_ID>/publish \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "X-Edit-Revision: <LAYER_REVISION>"
```
:::
:::tab[JavaScript]
```js title="publish.mjs"
const response = await fetch("http://localhost:3000/api/maps/<MAP_ID>/publish", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "X-Edit-Revision": "<LAYER_REVISION>",
  },
});
console.log(JSON.stringify(await response.json(), null, 2));
```
:::
::::

```json title="Output"
{
  "token": "<PUBLISH_TOKEN>",
  "publishedAt": "2026-10-20T09:00:01.521Z",
  "editRevision": "<PUBLISH_REVISION>",
  "lastChangedAt": "2026-10-20T09:00:01.521Z",
  "lastChangedBy": { "name": "<YOUR_NAME>", "sqlName": "<YOUR_SQL_NAME>" }
}
```

Open `http://localhost:3000/v/<PUBLISH_TOKEN>`. You should see the map with its 15 cities. Anyone with the link can open it, without an account.

- The published view opens in the dark theme. Send the body `{"theme": "light"}` with the request for the light one.
- To stop sharing, send `DELETE` to the same address with the map's newest `editRevision`. The link stops working at once.

[Share and publish](../use/share-and-publish.md#publish-a-map) covers publishing in the app and embedding the map in a web page.

## Troubleshooting

### A call answers 401 `authentication_required`

The call carried no token, or one Dezfil doesn't accept. Check that the `Authorization` header holds the whole token, beginning `dz_token_`. A revoked token answers the same: create a new one.

From the curl script of step 1, this answer to the token request means the sign-in before it failed. Check the email, the password and the `Origin` header.

### Signing in or creating a token answers 403 `forbidden`

The answer says "This request must come from the same instance." The `Origin` header is missing or names another address. Send the address the calls use, such as `http://localhost:3000`.

### A change answers 400 `invalid_request`

The answer says "Read this item first, then send its editRevision in X-Edit-Revision." The change carried no `X-Edit-Revision`, or a malformed one. Send the `editRevision` from the map's newest answer.

### A change answers 409 `stale_revision`

The map changed after the answer your revision came from, for example in the builder. Nothing was changed. Read the map with `GET /api/maps/<MAP_ID>`, see what changed, then make your change again with that answer's `editRevision`, as [Edit with revisions](http-api.md#edit-with-revisions) shows.

### Creating a token or publishing answers 403 `rule_refused`

A rule an admin sets leaves your account out: only admins may do this or, for publishing, no one. The answer's `rule` field names the rule. An admin changes it in **Settings**: **Who may create tokens** under **Security**, **Who may publish** under **Publishing**. [Security and rules](../self-host/configuration/rules.md) lists both.

## Next steps

- [How the API works](http-api.md): the address, signing in, edit revisions, who may do what, paging and errors.
- [Operation reference](https://dezfil.io/docs/api/reference/): every operation with its fields, built from the API description, [openapi.json](openapi.json).
- [Errors](errors.md): what an error answer holds, and what to do about each common code.
- [Limits](limits.md): upload sizes, SQL results and the settings that change them.
- [Connect an AI agent](mcp.md): the same operations as tools for Claude Code, Codex or Cursor.
