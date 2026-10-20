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

Run it with `node error.mjs`.

```text title="Output"
400 sql_error The query refers to an unknown table.
```
:::
::::

## What an error answer holds

Every error answer holds one `error` object. These two fields are always in it:

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
| `issues` | `geometry_choice_invalid` | Each reason the geometry choice fails, with its own `code` and `message`. |

> [!NOTE]
> Over MCP, a failed tool call is marked as an error. Its result holds an `error` object with `code`, `message` and, where they apply, `position` and `issues`.

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
| `token_expired` | 401 | The token reached the expiry it was created with. | Create a new token and use it instead. |
| `forbidden` | 403 | The operation is for admins, or you can view the item but not change it. Nothing changed. | Use an admin's token for admin operations. To change someone else's work, ask the owner of its project to make you an **Editor**. Some changes, such as deleting or publishing a map, stay its owner's. |
| `rule_refused` | 403 | An instance rule leaves you out, such as **Who may publish**. The `rule` field names it. Nothing changed. | Ask an admin to change the rule in **Settings**. |
| `not_found` | 404, or 410 for an expired download ticket | The item does not exist, or your account cannot reach it. Both answer the same. | Check the id. A list call, such as `GET /api/maps`, shows what you reach. |

### Requests and edits

| Code | Status | What happened | What to do |
|---|---|---|---|
| `invalid_request` | 400, in a few cases 404, 409, 410 or 422 | The request is malformed, or a field fails validation. A change to a map or workflow that sends no edit revision, or a malformed one, answers this too. | Fix what the message names. Read a map or workflow before you change it, and send its `editRevision` in the `X-Edit-Revision` header. |
| `method_not_allowed` | 405 | The path exists, but not with this method. | Use a method from the `Allow` header. |
| `stale_revision` | 409 | Someone changed the item after you read it. Your change was not applied. | Read the item again, then redo your change on what you find. |
| `name_taken` | 409, or 400 when you save a workflow step | A dataset of that name exists already. | Choose another name. |
| `run_in_flight` | 409 | The workflow is already running, and a workflow runs one run at a time. | Wait for the run to finish, or cancel it, then start again. |
| `refresh_in_flight` | 409 | A refresh of this dataset is already running. | Retry when it finishes. |
| `request_body_too_large` | 413 | The body is over the operation's byte limit. | Send a smaller body. The [operation reference](https://dezfil.io/docs/api/reference/) gives each operation's limit. |
| `upload_too_large` | 413 | The file is over the instance's largest upload. | Send a smaller file, or ask an admin to raise the limit. See [Limits](limits.md). |
| `rate_limited` | 429 | Too many sign-in attempts or wrong current passwords, too many requests to a published map, or the OpenStreetMap service refused an import. | Wait, then retry. A sign-in or password refusal gives the wait in `retryAfter` and the `Retry-After` header. |

### SQL

| Code | Status | What happened | What to do |
|---|---|---|---|
| `sql_rejected` | 400 | The SQL is not one read-only `SELECT`, or it reads a file directly. | Send one `SELECT` over your datasets. |
| `sql_error` | 400 | The SQL failed to parse or run, or it names a dataset you cannot reach. | Fix the SQL. `position` points at the problem when the engine gives one. |
| `query_timeout` | 408 | The query ran past the instance's query time limit. | Narrow the query, with a `WHERE` or fewer columns. The message names the setting that raises the limit. See [Limits](limits.md). |
| `query_memory_exceeded` | 400 | The query needed more memory than the engine allows SQL. | Narrow the query, or ask the operator to raise `DEZFIL_QUERY_MEMORY_MB`. |
| `query_result_too_large` | 422 | The answer is over the size a query may return. See [Limits](limits.md). | Select fewer rows or columns. To get every row, download the result with `POST /api/query/export`. |

### Busy or failing server

| Code | Status | What happened | What to do |
|---|---|---|---|
| `operation_queue_full` | 503 | Too many operations are already waiting to run. | Retry once some finish. |
| `internal` | 500 | The server failed in a way that has no code of its own. | Retry once. If it fails again, the operator finds the detail in the server log. |

## Handle errors in your code

This helper returns the answer of a successful call and throws on an error,
with its status and code. It retries the two codes that mean "wait and try
again":

```js title="dezfil.mjs"
const base = "http://localhost:3000";
const token = "<YOUR_TOKEN>";
const waitAndRetry = new Set(["rate_limited", "operation_queue_full"]);

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
- `rate_limited` and `operation_queue_full` wait for the seconds in `Retry-After`, or 5 without it, and try again, three attempts in all.
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
read. Each accepted change answers with a new `editRevision`: send that one with
your next change.

### The message says more than the catalogue

The catalogue gives each code's general meaning. An answer's message adds the
detail of this request, such as the dataset, the limit or the setting that
changes it.

## Next steps

- [How the API works](http-api.md): the address, sign-in, edit revisions and who may do what.
- [Limits](limits.md): every limit, and the setting that changes it.
- [Error catalogue](https://dezfil.io/docs/api/reference/errors/): every code and what it means.
