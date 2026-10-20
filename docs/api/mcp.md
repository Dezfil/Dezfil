---
title: "Connect an AI agent"
summary: "Connect Claude Code, Codex, Cursor or another MCP client to Dezfil, so an agent can work with your maps, data and workflows."
read_when:
  - "you want an AI agent to build maps, query data or run workflows in Dezfil"
  - "you add Dezfil to Claude Code, Codex, Cursor or another MCP client"
  - "you want to limit what an agent can do with your account"
  - "an agent's calls answer 401, token_expired, forbidden or stale_revision"
  - "you want the Dezfil skill and references in Claude Code or Codex"
audience:
  - user
  - developer
  - agent
checked: none
moved_from:
  - "/docs/reference/mcp/"
order: 3
---

Every Dezfil instance runs an MCP server. Connect your AI client to it, and
the agent can read and build your maps, data and workflows, with your
account's rights.

Your client brings its own model, so the instance needs no AI key for this.
The assistant inside the app is a separate thing, with a provider key of its
own: see [Set up the assistant](../self-host/assistant.md).

## Step 1: Create an API token

1. In Dezfil, select **Settings** at the bottom of the left rail, then **API & MCP**.
2. In **API / MCP tokens**, enter a **Token name**, such as `Claude Code`, and select **Create token**.
3. Select **Copy token**, then **Done**. Dezfil shows the token only once.

You should see the new token in the list, marked **Never used**.

Put the token in an environment variable, once. Your client's configuration
then holds only the variable's name:

::::tabs
:::tab[macOS and Linux]
```sh title="~/.zshrc or ~/.bashrc"
export DEZFIL_API_TOKEN="<YOUR_TOKEN>"
```

Open a new terminal after you save the file.
:::
:::tab[Windows]
```powershell title="PowerShell"
[Environment]::SetEnvironmentVariable("DEZFIL_API_TOKEN", "<YOUR_TOKEN>", "User")
```

Open a new terminal after you run it.
:::
::::

## Step 2: Add Dezfil to your client

The examples use `http://localhost:3000`. For any other address, the **MCP
server** card below your tokens shows the right configuration: pick your
client under **MCP client** and select **Copy**.

::::tabs
:::tab[Claude Code]
```sh title="Terminal"
claude mcp add --transport http dezfil 'http://localhost:3000/api/mcp' --header 'Authorization: Bearer ${DEZFIL_API_TOKEN}'
```

The single quotes keep `${DEZFIL_API_TOKEN}` as a name: Claude Code fills in
the token each time it connects. Add `--scope user` after `claude mcp add` to
use Dezfil in every project, not only this one.
:::
:::tab[Codex]
```sh title="Terminal"
codex mcp add dezfil --url 'http://localhost:3000/api/mcp' --bearer-token-env-var DEZFIL_API_TOKEN
```

Or add the server to Codex's configuration file:

```toml title="~/.codex/config.toml"
[mcp_servers.dezfil]
url = "http://localhost:3000/api/mcp"
bearer_token_env_var = "DEZFIL_API_TOKEN"
```
:::
:::tab[Cursor]
Add this to `.cursor/mcp.json` in your project, or to `~/.cursor/mcp.json`
for every project:

```json title=".cursor/mcp.json"
{
  "mcpServers": {
    "dezfil": {
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:DEZFIL_API_TOKEN}"
      }
    }
  }
}
```
:::
:::tab[Any other client]
Any client that can send an `Authorization` header to a Streamable HTTP MCP
server works. Point it at your instance's address followed by `/api/mcp`, and
send the token as `Bearer <YOUR_TOKEN>` on every request.

Many clients read a file in this shape; write the variable in your client's
own syntax:

```json title="mcp.json"
{
  "mcpServers": {
    "dezfil": {
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer ${DEZFIL_API_TOKEN}" }
    }
  }
}
```

> [!NOTE]
> Claude Desktop's custom connectors can't send this header, and they connect from the cloud, so they can't reach an instance on your own network.
:::
::::

## Step 3: Check that it works

1. Restart your client, or start a new session, so it reads the variable.
2. Open the client's list of MCP servers: run `/mcp` in Claude Code or Codex, or open the MCP settings in Cursor. You should see `dezfil` connected, with its tools.
3. Ask the agent about your instance:

```text title="Prompt"
Which maps and datasets do I have in Dezfil?
```

The agent should call tools such as `list_maps` and `list_tables`, then answer
with the names on your **Maps** and **Data** pages. Your client may ask you to
allow each call first.

Then ask for something new, such as "Create a map called Agent test". The map
appears on your **Maps** page.

## What the agent can do

Each tool is one operation of the [HTTP API](http-api.md). The
[API reference](https://dezfil.io/docs/api/reference/) shows every operation
with its MCP tool name and its inputs.

| Group | What the agent can do | Some of its tools |
|---|---|---|
| Data | Upload and import data, from files, links, Overture, OpenStreetMap or PostGIS | `upload_table`, `inspect_table` |
| SQL | Run read-only SQL and download the full result | `run_sql`, `export_sql_result` |
| Maps | Create, change and undo maps, draw on them, render them as images | `create_map`, `export_map_image` |
| Layers | Add and style layers, read a field's values | `create_layer`, `update_layer` |
| Workflows | Build workflows step by step and run them | `create_recipe`, `run_recipe` |
| Operations | Run one operation, such as a buffer or a spatial join, into a new dataset | `run_operation` |
| Projects | File work into projects, share them, publish maps | `create_project`, `publish_map` |
| Templates | List templates and copy one into a new project | `copy_template` |
| Account and instance | Read your account; admins also manage users and settings | `get_account`, `list_users` |

Most workflow tools call a workflow a `recipe`. The agent's calls keep the
same [limits](limits.md#limits-an-operator-changes) as any other call.

## Permissions

A token acts as your account, so the agent reaches what you reach:

- Your own maps, data, workflows and connections.
- Projects shared with you, in your role there. A **Viewer** reads; an **Editor** also changes maps and workflows, and runs workflows.
- Admin tools, such as `list_users`, work only with an admin's token. Being an admin gives no access to other people's private work.

To give an agent less than your own access, ask an admin to invite a separate
account for it in **Users**, then share only the projects it needs.

The instance's rules hold for the agent too. For example, while **Who may
publish** leaves you out, `publish_map` answers `rule_refused`.

An admin can keep new tokens to admins, or make them expire, in **Settings** >
**Security** > **API tokens**. Tokens that already exist keep working.
[Security and rules](../self-host/configuration/rules.md) lists both settings.

To cut an agent off, select **Revoke** next to its token, then **Revoke token**.
Its next call fails.

## Edit safely

Maps and workflows carry an `editRevision`. A tool that changes one, or its
layers or steps, takes the revision you last read as `expected_revision`, and
answers with the new one. Each tool's inputs tell your agent so.

To make the same calls from a script, save this as `edit.mjs`. It creates a
map, then renames it and changes its basemap, reading your token from
`DEZFIL_API_TOKEN`:

<!-- revision-example -->
```js title="edit.mjs"
const base = "http://localhost:3000";
const token = process.env.DEZFIL_API_TOKEN;

let requestId = 0;
async function call(name, args) {
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  // The answer comes as plain JSON or as one server-sent event.
  const message = JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data: ")).slice(6));
  if (!response.ok || message.error) throw new Error(JSON.stringify(message.error));
  const result = message.result.structuredContent.result;
  if (message.result.isError) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

const created = await call("create_map", { name: "Field notes" });
let current = await call("get_map", { id: created.id });
current = await call("update_map", { id: created.id, name: "Survey map", expected_revision: current.editRevision });
current = await call("update_map", { id: created.id, basemap: "light", expected_revision: current.editRevision });
console.log(current.name, current.basemap, current.editRevision);
```

- `call` sends one `tools/call` request to `/api/mcp` with your token. It returns the tool's result, or throws the error code.
- `get_map` reads the map with its `editRevision`.
- Each `update_map` passes the revision from the answer before it, then keeps the new one.

Run it with Node.js 24 or newer, from a terminal where `DEZFIL_API_TOKEN` is
set:

```sh title="Terminal"
node edit.mjs
```

```text title="Output"
Survey map light a9dd49a7f0695fa9e786874aca261675
```

Your revision differs: each one is new. You should see a map called Survey
map on your **Maps** page. Delete it there when you are done.

- A change without a revision answers `invalid_request`.
- `stale_revision` means someone changed the item after you read it. Your edit was not applied: read it again and redo the edit on what you find.
- To make several map or layer edits one undo step, give each the same `change_group`.

A map's `lastChangedBy` names who made its last change: `{ name, sqlName }`
for an account, `{ deleted: true }` for a deleted account, or `null` when it
is unknown. A change's author can be a deleted account, and then no name is
kept.

An undo step's `author` and a workflow run's `runner` take the same three
forms.

## Add the Dezfil plugin

For Claude Code and Codex, the Dezfil plugin adds Dezfil's own skill to the
connection. The agent then knows how to use the tools, not only that they
exist.

The skill brings analysis guidance and two references, on cartography and on
DuckDB spatial SQL.

You prepare the plugin from a Dezfil checkout, with Node.js 24 or newer, for
one instance's address. The [plugin's README](../../plugins/dezfil/README.md)
gives the commands to prepare, install, check and remove it.

The plugin replaces the connection from Step 2, so remove that one when you
install the plugin.

Once it is installed, `/dezfil:dezfil` starts the skill in Claude Code.

## Troubleshooting

### Calls answer 401 `authentication_required`

The client sent no token, or one Dezfil doesn't accept. Test the token from the
terminal that starts your client:

::::tabs
:::tab[macOS and Linux]
```sh title="Terminal"
curl -s http://localhost:3000/api/account -H "Authorization: Bearer $DEZFIL_API_TOKEN"
```
:::
:::tab[Windows]
```powershell title="PowerShell"
curl.exe -s http://localhost:3000/api/account -H "Authorization: Bearer $env:DEZFIL_API_TOKEN"
```
:::
::::

```json title="Output"
{
  "account": {
    "id": "<ACCOUNT_ID>",
    "name": "<YOUR_NAME>",
    "email": "<YOUR_EMAIL>",
    "sqlName": "<YOUR_SQL_NAME>",
    ...
  }
}
```

If you see your account, the token works: restart the client from that
terminal. "Sign in to continue." means the variable is empty, or the token is
wrong or revoked: set the variable again, or create a new token.

### The Create token button is grayed out

The line under it reads "Only admins can create tokens on this instance." An
admin chose **Admins only** in **Settings** > **Security** > **Who may create
tokens**. Ask an admin to change it. Tokens you made earlier keep working.

### Calls answer `token_expired`

The token reached the expiry it was created with. Create a new token and put it
in `DEZFIL_API_TOKEN`. The old one shows **Expired** and its date in your token
list.

### The agent has no Dezfil tools

Run `/mcp` in Claude Code or Codex. If `dezfil` is missing, add it again. In
Claude Code, a server added without `--scope user` loads only in the project you
added it from.

### A tool answers `forbidden`

The tool needs an admin's token, or you can view the item but not change it.

### An upload answers `request_body_too_large`

Through MCP, the file travels inside one request, so it must stay under about
12 MB and under the instance's upload limit.
[The assistant and agents](limits.md#the-assistant-and-agents) gives the exact
figures.

Upload bigger files with **Add data** in the app, or through the
[HTTP API](http-api.md).

### The client can't reach the instance

Open the address from your configuration in a browser on the client's machine.
If nothing loads, start the instance or correct the address. A client that runs
in the cloud can't reach `localhost` or your private network.

To see whether the MCP server answers at all, select **Check connection** on
the **MCP server** card. You should see "Connected." with the number of tools
available. It uses your browser session, not your token.

## Next steps

- [API quickstart](quickstart.md): the same work over HTTP, with curl.
- [How the API works](http-api.md): sign-in, edit revisions, paging and errors.
- [Errors](errors.md): what an error answer holds, and what to do about each common code.
