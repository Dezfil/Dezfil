---
title: "Errors"
summary: "Read the error answer a failed API call returns, and know what to do about the codes a script or an agent meets most often."
read_when:
  - "a request or a tool call fails and you want to know why"
  - "you write a client or an agent that decides what to do when a call fails"
  - "a call answers stale_revision, rate_limited, query_timeout or query_result_too_large"
  - "you look up an error code this page does not list"
audience:
  - developer
  - agent
checked: none
order: 4
---

A failed request answers with an HTTP error status and a JSON body that names
what went wrong. Try it with a query on a dataset that does not exist:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s -w "\n%{http_code}\n" http://localhost:3000/api/query \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM no_such_dataset"}'
```

- `-w "\n%{http_code}\n"` prints the status after the body.
- `<YOUR_TOKEN>` is your API token. The [API quickstart](quickstart.md) shows how to create one.

```text title="Output"
{"error":{"code":"sql_error","message":"The query refers to an unknown table.","position":{"line":1,"column":15}}}
400
```
:::
:::tab[JavaScript]
```js title="error.mjs"
const response = await fetch("http://localhost:3000/api/query", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sql: "SELECT * FROM no_such_dataset" }),
});
const { error } = await response.json();
console.log(response.status, error.code, error.message);
```

Run it with Node.js 24 or newer: `node error.mjs`.

```text title="Output"
400 sql_error The query refers to an unknown table.
```
:::
::::

## What an error answer holds

Every error answer an operation gives holds one `error` object. These two fields are always in it:

| Field | What it holds |
|---|---|
| `code` | A stable name for what went wrong, such as `sql_error`. |
| `message` | A sentence for a person. It often names the detail of this request, such as a dataset, a limit or the setting that changes it. |

Branch on `code`, not on the message or the status. One status covers many
codes: 400 answers both `sql_error` and `invalid_request`.

Some codes add a field beside the two:

| Field | Comes with | What it holds |
|---|---|---|
| `position` | `sql_error`, when the engine reports where | The `line` and `column` of the problem in your SQL, counted from 1. |
| `retryAfter` | `rate_limited` from sign-in or a password check, and `authentication_busy` | The seconds to wait before you try again. The `Retry-After` header carries the same number. |
| `retryAt` | `rate_limited` from sign-in or a password check | The time you may try again. |
| `rule` | `rule_refused` | The instance rule that refused you: `tokens.create`, `publishing.publish`, `connections.create` or `imports.links`. |
| `setting` | `basemap_not_offered` | The basemap switch that refused it, such as `basemaps.satellite`. |
| `issues` | `geometry_choice_invalid`, and `invalid_request` for a tool's arguments over MCP | Each reason the request fails: a `code` and a `message` for a geometry choice, a `message` and the argument's `path` for a tool call. |

One operation adds a field of its own: the `already_signed_in` answer from an external sign-in arrival also holds `account`, the account already signed in to that browser. Its session stays unchanged.

> [!NOTE]
> Over MCP, a failed tool call is marked as an error. Its result holds an `error` object with `code`, `message` and, where they apply, `position` and `issues`. A tool takes the edit revision as its `expected_revision` argument. [Connect an AI agent](mcp.md#troubleshooting) helps with the client.

## What to do about common codes

Find the code in these tables, then do what its row says. The
[error catalogue](https://dezfil.io/docs/api/reference/errors/) lists every
other code with its meaning, and [Limits](limits.md) gives the code each
limit answers with.

Agents can read the same list from the [API description](openapi.json):
`x-error-codes` maps each code to its meaning.

### Sign-in and permission

| Code | Status | What happened | What to do |
|---|---|---|---|
| `authentication_required` | 401 | The request has no token, or one Dezfil doesn't accept: mistyped, revoked, or its account deactivated. | Send the header `Authorization: Bearer <YOUR_TOKEN>`. If it still fails, create a new token. |
| `token_outdated` | 401 | **This token was made before everyone was signed out and no longer works. Create a new one.** | Sign in again and create a new API token. |
| `invalid_ticket` | 401 | The external ticket, browser start, audience, time, generation or signature is invalid, or the ticket id was already accepted. | Begin again from the instance. See the [door guide](../self-host/sign-in-service.md). |
| `already_signed_in` | 409 | The browser already holds the account in `error.account`. Nothing changed. | Sign out before starting another sign-in. |
| `account_not_invited` | 403 | No account matches the verified identity, or that email is bound to another identity. | Ask an admin for an invitation using the verified email. |
| `external_sign_in_only` | 403 | **This instance signs people in through its sign-in service. Passwords and sign-in links are unavailable.** | Use the sign-in service; email changes also come from it. |
| `token_expired` | 401 | The token reached the expiry it was created with. | Create a new token and use it instead. |
| `forbidden` | 403 | The operation is for admins, you can view the item but not change it, or a request signed in with the session cookie lacks the instance's `Origin`. Nothing changed. | Use an admin's token for admin operations. For an item you can't change, see [Who may do what](http-api.md#who-may-do-what); for the `Origin`, [Sign in](http-api.md#sign-in). |
| `rule_refused` | 403 | An instance rule leaves you out, such as **Who may publish**. The `rule` field names it. Nothing changed. | Ask an admin to change the rule in **Settings**. |
| `not_found` | 404, or 410 for an expired query download | The item does not exist, or your account cannot reach it. Both answer the same. | Check the id. A list call, such as `GET /api/maps`, shows what you reach. |

### Requests and edits

| Code | Status | What happened | What to do |
|---|---|---|---|
| `invalid_request` | 400, in a few cases 404, 409, 410 or 422 | The request is malformed, or a field fails validation. A change to a map or workflow that sends no edit revision, or a malformed one, answers this too. | Fix what the message names. Read a map or workflow before you change it, and send its `editRevision` in the `X-Edit-Revision` header, or over MCP as the `expected_revision` argument. |
| `method_not_allowed` | 405 | The path exists, but not with this method. | Use a method from the `Allow` header. |
| `stale_revision` | 409 | Someone changed the item after you read it. Your change was not applied. | Read the item again, then redo your change on what you find. |
| `name_taken` | 409, or 400 when you save a workflow step | A dataset of that name exists already. | Choose another name. |
| `run_in_flight` | 409 | The workflow is already running, and a workflow runs one run at a time. | Wait for the run to finish, or cancel it, then start again. |
| `refresh_in_flight` | 409 | A refresh of this dataset is already running. | Retry when it finishes. |
| `request_body_too_large` | 413 | The body is over the operation's byte limit. | Send a smaller body. The [operation reference](https://dezfil.io/docs/api/reference/) gives each operation's limit. |
| `upload_too_large` | 413 | The file is over the instance's largest upload, or a picture is over its fixed 10 MB. | Send a smaller file, or ask an admin to raise the limit. A picture's limit is fixed. See [Limits](limits.md). |
| `unsupported_image` | 415 | The picture is not a still JPEG, PNG or WebP image: an SVG, a GIF, an animated image, or one damaged or incomplete. Nothing changed. | Choose a still JPEG, PNG or WebP image. |
| `image_too_large` | 413 | The picture has more than 64 million pixels, a fixed limit. Nothing changed. | Choose a smaller image. |
| `rate_limited` | 429 | Too many sign-in attempts or wrong current passwords, too many requests to a published map, or the OpenStreetMap service refused an import. | Wait, then retry. A sign-in or password refusal gives the wait in `retryAfter` and the `Retry-After` header. |

### SQL

| Code | Status | What happened | What to do |
|---|---|---|---|
| `sql_rejected` | 400 | The SQL is not one read-only `SELECT`, or it reads a file directly. | Send one `SELECT` over your datasets. |
| `sql_error` | 400 | The SQL failed to parse or run, or it names a dataset you cannot reach. | Fix the SQL. `position` points at the problem when the engine gives one. Another person's dataset is `<sql name>.<dataset>`: see [Who may do what](http-api.md#who-may-do-what). |
| `query_timeout` | 408 | The query ran past the instance's query time limit. | Narrow the query, with a `WHERE` or fewer columns. The message names the setting that raises the limit. See [Limits](limits.md). |
| `query_memory_exceeded` | 400 | The query needed more memory than the engine allows SQL. | Narrow the query, or ask the operator to raise `DEZFIL_QUERY_MEMORY_MB`. |
| `query_result_too_large` | 422 | The answer, or one value in it, is over a byte limit, so no rows come back. A query answers this, and so do a dataset's page, a geometry or PostGIS preview, a layer's filter values and a category fill. | Narrow the query, or keep every row: [Answers too large to return](#answers-too-large-to-return) says what to do at each read. |

### The assistant

| Code | Status | What happened | What to do |
|---|---|---|---|
| `assistant_disabled` | 404 | You have no usable key and the instance has none. | Save yours with `PUT /api/account/assistant-key`. |
| `assistant_auth` | 401 or an event | The provider refused the key that paid. | The message says whose. Replace your own, or tell an admin. |
| `assistant_key_changed` | 409 | Your key was replaced or removed after this turn began, so the turn ended. | Send a new message. |
| `assistant_reservation_limit` | 409 | You hold two reservations you have not sent. | Send on one, or release one with `DELETE /api/assistant/runs/{id}`. They expire after five minutes. |
| `assistant_capacity` | 409 | All eight runs are taken, or your four are. Your reservation stays. | Abandon a waiting turn, or retry once one finishes. |

### Busy or failing server

| Code | Status | What happened | What to do |
|---|---|---|---|
| `operation_queue_full` | 503 | Too many operations are already waiting to run. | Retry once some finish. |
| `authentication_busy` | 503 | Too many sign-ins or password checks are waiting their turn. | Retry after the seconds in `Retry-After`. |
| `internal` | 500 | The server failed in a way that has no code of its own. | Retry once. If it fails again, the operator finds the detail in the server log. |

## Answers too large to return

[Limits](limits.md#sql-results) gives the two byte limits behind `query_result_too_large`, and how geometry counts. No setting raises them, so what to do depends on the read that answers it:

| The read | What to do |
|---|---|
| A query, on the **SQL** page, with `POST /api/query` or `run_sql` | Narrow it, as [Query with SQL](../use/sql.md#troubleshooting) shows. To keep every row, [download it](#download-every-row) or [save it as a dataset](#save-every-row-as-a-dataset). In the app, a [SQL step](../use/workflows.md#save-a-query-with-a-sql-step) saves it, and the dataset's export in **Data** downloads it. |
| A dataset's page, or its **Set geometry** panel | Keep a copy without the large column, as [A dataset's page does not open](#a-datasets-page-does-not-open) shows. |
| A layer's **Filters** or **Color by**, or a **Category** widget's **Group by** | Choose another column: one with a value that long holds no categories. |
| The PostGIS five-row preview | Import the table all the same: an import is not held to these limits. |

### Download every row

An export runs the same query and streams every row of its result as a file, with no byte limit:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/query/export \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT name, country, population FROM world_cities ORDER BY population DESC LIMIT 3", "format": "csv", "name": "largest_cities"}'
```
:::
:::tab[JavaScript]
```js title="export.mjs"
const response = await fetch("http://localhost:3000/api/query/export", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    sql: "SELECT name, country, population FROM world_cities ORDER BY population DESC LIMIT 3",
    format: "csv",
    name: "largest_cities",
  }),
});
console.log((await response.text()).trimEnd());
```

Run it with `node export.mjs`.
:::
::::

```csv title="Output"
name,country,population
Tokyo,Japan,35676000
New York,United States of America,19040000
Mexico City,Mexico,19028000
```

- `sql` is your query, here over the `world_cities` dataset of the [API quickstart](quickstart.md).
- `format` is `csv`, `geoparquet` or `geojson`. CSV writes geometry as WKT text. GeoJSON needs a geometry column and uses the first one.
- `name` names the file, here `largest_cities.csv`. Without it the file is `query_result.csv`.
- curl prints the file. To save it instead, add `-o largest_cities.csv -w "%{http_code}\n"`: `200` means the file holds the rows, and any other status that it holds the error answer.

The export still keeps to the **Query time limit** and **Engine memory**, so it can answer `query_timeout` or `query_memory_exceeded`. The [operation reference](https://dezfil.io/docs/api/reference/query/#post-api-query-export) gives every field.

Over MCP, the tool `export_sql_result` hands the file back to the agent, up to **Tool attachment size**. A larger file fails with `attachment_too_large`: download it over HTTP, or save the rows as a dataset with `run_operation`, as the next section shows.

### Save every row as a dataset

A run of the operation `sql_step` saves every row of a query as a new dataset, with no byte limit:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/operations/run \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"operation": "sql_step", "parameters": {"sql": "SELECT name, country, population, geometry FROM world_cities WHERE population > 10000000", "name": "big_cities"}}'
```
:::
:::tab[JavaScript]
```js title="save.mjs"
const response = await fetch("http://localhost:3000/api/operations/run", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    operation: "sql_step",
    parameters: {
      sql: "SELECT name, country, population, geometry FROM world_cities WHERE population > 10000000",
      name: "big_cities",
    },
  }),
});
console.log(JSON.stringify(await response.json()));
```

Run it with `node save.mjs`.
:::
::::

```json title="Output"
{"run":{"id":"<RUN_ID>","operation":"sql_step","state":"queued",...}}
```

- `parameters` holds the query as `sql` and the new dataset's `name`. A name already taken answers 409 `name_taken`, and nothing runs.
- The answer comes at once, with the run's `id`, and the run writes the dataset afterwards.

Read the run to see how it ended:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/operations/runs/<RUN_ID> \
  -H "Authorization: Bearer <YOUR_TOKEN>"
```
:::
:::tab[JavaScript]
```js title="read-run.mjs"
const response = await fetch("http://localhost:3000/api/operations/runs/<RUN_ID>", {
  headers: { Authorization: "Bearer <YOUR_TOKEN>" },
});
console.log(JSON.stringify(await response.json()));
```

Run it with `node read-run.mjs`.
:::
::::

```json title="Output"
{"run":{"id":"<RUN_ID>","operation":"sql_step","state":"succeeded",...,"finishedAt":"2026-10-20T09:00:01.503Z","output":{"id":"<DATASET_ID>","name":"big_cities"}}}
```

- `state` is `queued`, then `running`. Read the run again every few seconds until it is `succeeded`, `failed` or `cancelled`.
- A succeeded run names its dataset under `output`. A failed one holds an `error` with a `code` and a `message`, such as `sql_error`, or `operation_timeout` past **Time limit per tool run**.
- Over MCP, `run_operation` takes the same `operation` and `parameters`, and `get_operation_run` reads the run.

The [operation reference](https://dezfil.io/docs/api/reference/operations/#post-api-operations-run) gives every field of a run.

## Handle errors in your code

This helper returns the answer of a successful call and throws on an error,
with its status and code. It retries the three codes that mean "wait and try
again":

```js title="dezfil.mjs"
const base = "http://localhost:3000";
const token = "<YOUR_TOKEN>";
const waitAndRetry = new Set(["rate_limited", "operation_queue_full", "authentication_busy"]);

export async function request(method, path, { body, headers = {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const answer = await response.json().catch(() => null);
    if (response.ok) return answer;
    const error = answer?.error ?? { code: `http_${response.status}`, message: response.statusText };
    if (!waitAndRetry.has(error.code) || attempt === 3) {
      throw Object.assign(new Error(`${response.status} ${error.code}: ${error.message}`), { status: response.status, error });
    }
    const seconds = Number(response.headers.get("Retry-After")) || 5;
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
}
```

- A successful call returns its JSON answer, or `null` when the answer is not JSON or has no body.
- `rate_limited`, `operation_queue_full` and `authentication_busy` wait for the seconds in `Retry-After`, or 5 without it, and try again, three attempts in all.
- Every other error throws. `failure.error` keeps the whole `error` object, with any extra fields.
- An answer without an `error` object gets the code `http_<status>`, such as `http_404`. See [Troubleshooting](#troubleshooting).

Call it the way you call the API:

```js title="query.mjs"
import { request } from "./dezfil.mjs";

try {
  await request("POST", "/api/query", { body: { sql: "SELECT * FROM no_such_dataset" } });
} catch (failure) {
  console.log(failure.message);
}
```

Run it with `node query.mjs`, with both files in one folder.

```text title="Output"
400 sql_error: The query refers to an unknown table.
```

Leave `stale_revision` out of the retry list: the same change with the same
revision fails again. Read the item, then send your change with the new
`editRevision`. [How the API works](http-api.md#edit-with-revisions) shows the
pattern.

## Troubleshooting

### A 404 answer has no `error` object

The path does not exist, so Dezfil answers with its not-found page. Check the
path and its spelling against the
[operation reference](https://dezfil.io/docs/api/reference/).

### Every change answers `stale_revision`

Check that you send the revision from the latest answer, not from your first
read. [Edit with revisions](http-api.md#edit-with-revisions) shows the chain.

### A dataset's page does not open

A dataset whose first 50 rows are too large to return keeps its page and **Set geometry** closed, and its inspection answers `query_result_too_large`. Text there shows only its first 512 characters, so the large value is of another kind, such as JSON, a list, a binary value or a second geometry column.

To find its column, run this on the **SQL** page, or with `POST /api/query` or `run_sql`:

```sql title="SQL"
SELECT max(length(CAST(COLUMNS(*) AS VARCHAR))) FROM <DATASET>;
```

It answers one row: the length of each column's longest value, in characters, under the column's name. The column to leave out shows a number in the millions. The dataset's own geometry column does not count.

Keep a copy without that column: on the **SQL** page, run `SELECT * EXCLUDE (<COLUMN>) FROM <DATASET>` and click **Save as dataset**. If that query answers `query_result_too_large` too, save it as a **SQL step** in a [workflow](../use/workflows.md), or as [Save every row as a dataset](#save-every-row-as-a-dataset) shows. The copy's page opens.

### The message says more than the catalogue

The catalogue gives each code's general meaning. An answer's message adds the
detail of this request, such as the dataset, the limit or the setting that
changes it.

## Next steps

- [How the API works](http-api.md): the address, sign-in, edit revisions and who may do what.
- [Limits](limits.md): every limit, and the setting that changes it.
- [Error catalogue](https://dezfil.io/docs/api/reference/errors/): every code and what it means.
