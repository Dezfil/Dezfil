---
title: "How the API works"
summary: "Call Dezfil's HTTP API from a script: the address, signing in, editing with revisions, who may do what, paging, errors and PostGIS connection strings."
read_when:
  - "you call Dezfil over HTTP from a script, a program or an agent"
  - "you need an API token, or want to know how the app's browser session signs in"
  - "a change to a map or workflow answers invalid_request or stale_revision"
  - "a call answers forbidden or not_found for something you expect to reach"
  - "you want to page through a long list of datasets"
audience:
  - developer
  - agent
checked: none
moved_from:
  - "/docs/reference/http-api/"
order: 2
---

Send every call to your instance's address, under `/api`, with your API token:

```sh title="Terminal"
curl -s http://localhost:3000/api/account -H "Authorization: Bearer <YOUR_TOKEN>"
```

- `http://localhost:3000` is the address you open Dezfil at. Behind your own domain, use that address, such as `https://maps.example.com`.
- `/api/account` is the operation: it reads the account the token belongs to.
- `Authorization: Bearer` carries the token. [Make a token](#make-a-token) shows how to get one.

```json title="Output"
{"account":{"id":"<ACCOUNT_ID>","name":"<YOUR_NAME>","email":"<YOUR_EMAIL>","sqlName":"<YOUR_SQL_NAME>",...}}
```

Paths carry no version number. Request bodies are JSON, except a file upload, which is a `multipart/form-data` form.

Answers are JSON, except the files you download, such as exports, tiles and map pictures, and the assistant's reply, which streams as lines of JSON. A `204` answer, such as a deleted map's, has no body.

The [operation reference](https://dezfil.io/docs/api/reference/) lists every operation with its parameters, body and answers. It is built from [`openapi.json`](openapi.json), an OpenAPI 3.1 description you can give to a client generator or an agent.

Your instance serves the same description at `/api/openapi.json`, and shows it as a reference at `/developer`. Both need you signed in.

## Headers

| Header | When to send it |
|---|---|
| `Authorization: Bearer <YOUR_TOKEN>` | On every call that needs sign-in. |
| `Content-Type: application/json` | With every JSON body. |
| `X-Edit-Revision` | On a change to a map or workflow: the `editRevision` you last read. See [Edit with revisions](#edit-with-revisions). |
| `X-Change-Group` | Optional, on map and layer edits that should undo as one step. Any value of 1 to 64 letters, digits, `_` or `-`; send the same value with each edit. |
| `X-Dezfil-Account` | Optional: the account ID you expect. A credential of another account answers `401 authentication_required`. |

## Sign in

| Way | For | How |
|---|---|---|
| API token | Scripts, programs, agents and MCP clients | Send it in the `Authorization` header on every call. |
| Session cookie | The app's own pages in your browser | The cookie the app sets when you sign in. It lasts as long as **Stay signed in for** says, counted from your last visit. |

Both act as your account, with its rights. A change sent with the session cookie must carry an `Origin` header with the instance's own address, as the app's pages do, or it answers `403 forbidden`.

A token works from any script or program that reaches the instance. A web page on another site can't call the API, since the instance allows no cross-origin requests.

A few calls need no sign-in: `GET /api/health`; `GET /api/auth/entry`, which reads what the sign-in screen shows; signing in, creating the first account and redeeming a sign-in link; the external sign-in start and arrival POSTs; and a published map's calls under `/api/published/<PUBLISH_TOKEN>`.

[Security and rules](../self-host/configuration/rules.md) lists **Stay signed in for** and the token rules below, with their defaults.

### External sign-in

The [door guide](../self-host/sign-in-service.md) gives the signing format and browser exchange.

| Read or refusal | Meaning |
|---|---|
| `GET /api/auth/entry` | Reports `externalSignIn.enabled` and `externalSignIn.doorUrl`. |
| `403 external_sign_in_only` | Setup, password sign-in, link issuance and redemption, password changes and email changes are unavailable in this mode. |
| `409 already_signed_in` | Arrival names the browser's current account in `error.account`, without changing or renewing its session. |
| `401 token_outdated` | Either generation rose. Sign in again and create a new token. |

| Operation | Result |
|---|---|
| `POST /api/auth/external/start` | Sets the browser's ten-minute start cookie and redirects to the door. Requires the instance's `Origin`. |
| `POST /api/auth/external/arrive` | Accepts `{"ticket":"<COMPACT_JWS>"}` with that cookie and `Origin`. The body is bounded to 8,192 bytes. Returns the account and session cookie. |
| `POST /api/users` | An admin's invitation returns only `account` in external mode. In password mode it also returns `signInUrl` and `expiresAt`. Clients must allow these link fields to be absent. |
| `POST /api/instance/sign-out` | An admin raises the sign-out generation in either mode, ending all earlier sessions and tokens, including their own, and older assistant work. |

Start and arrival have no MCP tool. Tickets never authenticate API or MCP calls.

### Make a token

Make your first token in the app: in **Settings** › **API & MCP**, enter a **Token name** under **API / MCP tokens** and select **Create token**. The [API quickstart](quickstart.md) walks you through it, and shows how to make one from a script. With one token, you can make more over the API:

```sh title="Terminal"
curl -s http://localhost:3000/api/account/tokens \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Nightly import"}'
```

```json title="Output"
{"id":"<TOKEN_ID>","name":"Nightly import","createdAt":"2026-10-20T09:00:00.794Z","lastUsedAt":null,"revokedAt":null,"expiresAt":null,"secret":"<NEW_TOKEN>"}
```

- `secret` is the new token. It is in this answer only, so store it somewhere safe.
- `expiresAt` is when the token stops working, or `null` if it never does. An admin sets how long new tokens last with **New tokens expire after**, in **Settings** › **Security**.

`GET /api/account/tokens` lists your tokens without their secrets. `DELETE /api/account/tokens/<TOKEN_ID>` revokes one, and its next call answers `401 authentication_required`.

An expired token answers `401 token_expired`. If an admin lets only admins create tokens, with **Who may create tokens**, creating one answers `403 rule_refused`.

> [!WARNING]
> A token can do everything your account can. Keep it out of code you share. If it leaks, select **Revoke** next to it in **Settings** › **API & MCP**, then **Revoke token**.

## Edit with revisions

Every map and workflow carries an `editRevision`. A change sends the revision it last read in `X-Edit-Revision`, and each accepted change answers with the next one. Create a map, then change it twice:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/maps \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Field notes"}'
```

```json title="Output"
{"id":"<MAP_ID>","name":"Field notes",...,"editRevision":"<MAP_REVISION>","lastChangedAt":"2026-10-20T09:00:01.507Z","lastChangedBy":{"name":"<YOUR_NAME>","sqlName":"<YOUR_SQL_NAME>"},...}
```

Rename the map, sending the revision of that answer:

```sh title="Terminal"
curl -s -X PATCH http://localhost:3000/api/maps/<MAP_ID> \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "X-Edit-Revision: <MAP_REVISION>" \
  -d '{"name": "Survey map"}'
```

```json title="Output"
{"id":"<MAP_ID>","name":"Survey map",...,"editRevision":"<RENAME_REVISION>",...}
```

Change its basemap, sending the revision the rename gave:

```sh title="Terminal"
curl -s -X PATCH http://localhost:3000/api/maps/<MAP_ID> \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "X-Edit-Revision: <RENAME_REVISION>" \
  -d '{"basemap": "light"}'
```

```json title="Output"
{"id":"<MAP_ID>","name":"Survey map",...,"basemap":"light",...,"editRevision":"<BASEMAP_REVISION>",...}
```
:::
:::tab[JavaScript]
Save this as `revisions.mjs`, with your token in place of `<YOUR_TOKEN>`:

<!-- revision-example -->
```js title="revisions.mjs"
const base = "http://localhost:3000";
const token = "<YOUR_TOKEN>";

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(method === "PATCH" ? { "X-Edit-Revision": current.editRevision } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

let current = await request("POST", "/api/maps", { name: "Field notes" });
const path = `/api/maps/${current.id}`;
current = await request("PATCH", path, { name: "Survey map" });
current = await request("PATCH", path, { basemap: "light" });
console.log(current.name, current.basemap, current.editRevision);
```

- `request` sends one call with your token. On a `PATCH`, it adds the revision of the last answer.
- Each `current = await` keeps the answer, so the next change sends its revision.

Run it with Node.js 24 or newer:

```sh title="Terminal"
node revisions.mjs
```

```text title="Output"
Survey map light f4caf280e5001ee179e0f48ecf207df8
```

Your revision differs: each one is new.
:::
::::

You should see a map named `Survey map` on your **Maps** page. Delete it there when you are done.

For a map that already exists, read it first with `GET /api/maps/<MAP_ID>`. Its answer carries the `editRevision` the same way.

- Send the revision on every change to a map or workflow, its layers and steps included. The reference marks each operation that takes `X-Edit-Revision`.
- Make one change at a time: wait for its answer, then send the next change with the revision it gave.
- A change without a revision, or with a malformed one, answers `400 invalid_request` and changes nothing.
- `409 stale_revision` means someone changed the item after you read it: "This item has changed. Reload it before trying again." Your change was not applied.
- After `stale_revision`, read the item again and redo your change on what you find. Never resend the old change with the new revision.
- Moving only a map's view, `viewport` alone, needs no revision.

### Who made the last change

Map and workflow answers carry `lastChangedAt` and `lastChangedBy`, the account behind the last accepted change. `lastChangedBy` takes one of three forms:

- `{ name, sqlName }`: the account that made the change.
- `{ deleted: true }`: a deleted account. A change's author can be a deleted account, and then no name is kept.
- `null`: the author is not known.

An undo step's `author` and a workflow run's `runner` take the same three forms.

## Who may do what

A token reaches what its account reaches: your own work, and everything filed in the projects shared with you. A project's `role` names how you stand to it.

| You are | You read | You change |
|---|---|---|
| The owner of a map, workflow or dataset | It | Everything: you delete it, transfer a map or workflow, and publish a map |
| An `editor` of a project | Everything filed in the project | Its maps and workflows; you run its workflows and file your own work in it |
| A `viewer` of a project | Everything filed in the project | Nothing; you may duplicate a map or workflow into your own space |
| The `owner` of a project | Everything filed in the project | You rename, share, transfer and dissolve the project, and change its maps and workflows |
| An admin | Only what your own account reaches | Accounts, under `/api/users`, and the instance's settings, under `/api/instance` |

- A dataset changes, refreshes and is deleted only by its owner, whatever the role. Connections are never shared.
- Something you don't reach answers `404 not_found`, exactly as if it did not exist. A change you may not make to something you reach answers `403 forbidden`, and nothing changes.
- In SQL and in dataset reads, another person's dataset is `<sql name>.<dataset>`, such as `ana_diaz.stations`. Every dataset list gives each one's `qualifiedName`, the name to send.

The API calls a workflow a recipe: workflows live under `/api/recipes`. [Share and publish](../use/share-and-publish.md) shows how to share a project in the app.

## Lists and paging

Most lists answer everything you reach, in one answer. Add `?project=<PROJECT_ID>` to keep one project's items, or `?project=none` to keep your own items that are in no project.

| Operation | How it pages |
|---|---|
| `GET /api/catalogue/tables` | `limit`: datasets per page, 1 to 32, default 32. `after`: the `nextAfter` of the page before. `columns`: columns per dataset, 0 to 64, default 64. `columnOffset`: the column to continue from. It takes `project` too. |
| `GET /api/operations/runs` | `limit`: how many runs, newest first; 100 by default, at most 1,000. |
| `GET /api/maps`, `GET /api/tables`, `GET /api/recipes` and every other list | No paging. `project` narrows the first three. |

The catalogue gives each dataset's columns without reading its rows. With two datasets, the quickstart's `world_cities` and the `world_cities_2` that uploading it again makes, the first page of one:

```sh title="Terminal"
curl -s "http://localhost:3000/api/catalogue/tables?limit=1" -H "Authorization: Bearer <YOUR_TOKEN>"
```

```json title="Output"
{"tables":[{"id":"<DATASET_ID>","name":"world_cities","qualifiedName":"world_cities",...,"columnCount":6,"nextColumnOffset":null}],"total":2,"nextAfter":"world_cities"}
```

Your answer lists your own datasets.

- `total` counts every dataset that matches, on all pages.
- `nextAfter` is the last name on this page. Send it as `after=world_cities` for the next page. It is `null` on the last page.
- `nextColumnOffset` is set when a dataset has more columns than the page. Ask again with `names=<NAME>` and that `columnOffset`.

A query answers a preview of its rows with the exact row count. [Limits](limits.md) gives the preview's size and every other limit.

## Errors

A refused call answers an error status and a JSON body with a code:

```sh title="Terminal"
curl -s -w "\n%{http_code}\n" http://localhost:3000/api/maps/no-such-map -H "Authorization: Bearer <YOUR_TOKEN>"
```

```text title="Output"
{"error":{"code":"not_found","message":"The requested resource was not found."}}
404
```

- `-w "\n%{http_code}\n"` prints the status after the body.
- Branch on `code`, not on the message or the status.

[Errors](errors.md) says what an error answer holds and what to do about each common code. The [error catalogue](https://dezfil.io/docs/api/reference/errors/) lists every code, and the [operation reference](https://dezfil.io/docs/api/reference/) the statuses each operation answers.

## Connections

`POST /api/connections/postgis` saves a PostGIS connection, and `PATCH /api/connections/postgis/<CONNECTION_ID>` changes one. Both take a `url`: a Postgres URL, such as `postgres://ana@db.example.com:5432/gis`, or a key-value string, such as `host=db.example.com dbname=gis user=ana`.

- Dezfil reads the string once and never stores or returns it. It keeps the host, port, database, user name, password and SSL choice, and leaves out every other parameter.
- A field you send on its own, such as `password`, wins over the same part of the string.
- `sslmode=require` requires SSL. `prefer`, `disable` and `allow` don't. Without one, a new connection requires SSL and a change keeps the saved choice.
- `verify-ca`, `verify-full`, an unknown mode, or two different modes are refused.

Some parameters ask for a protection Dezfil can't give. A string that gives one of them a value other than those listed here is refused, before Dezfil contacts the database:

| Parameter | Values Dezfil accepts and leaves out |
|---|---|
| `channel_binding`, `gssencmode` | `prefer`, `disable` |
| `sslcertmode` | `allow` |
| `sslsni` | `1` |
| `sslcompression`, `gssdelegation` | `0`, `1` |
| `sslnegotiation` | `postgres` |
| `requiressl` | `0` |
| `ssl` | `false` |
| `options`, `service`, `min_protocol_version`, `ssl_min_protocol_version`, `ssl_max_protocol_version` | none |
| `sslrootcert`, `sslcrl`, `sslcrldir`, `sslcert`, `sslkey`, `sslpassword` | none |
| `require_auth`, `krbsrvname`, `gsslib` | none |
| `scram_client_key`, `scram_server_key` | none |
| `oauth_issuer`, `oauth_client_id`, `oauth_client_secret`, `oauth_scope` | none |

- An empty value counts as left out. Names match in any case, and every time a name appears counts, so a later value can't hide a refused one.
- The answer is `400 invalid_request`: "This connection string uses the unsupported protection parameter channel_binding; Dezfil supports connection fields and SSL required or not required." The first refused parameter's name stands in place of `channel_binding`.
- A refused string changes nothing. A saved connection isn't checked again, since its string was never kept.

## Next steps

- [API quickstart](quickstart.md): list maps, upload a CSV, run SQL, add a layer and publish the map.
- [Connect an AI agent](mcp.md): the same operations as MCP tools.
- [Limits](limits.md): every limit, and the setting that changes it.
