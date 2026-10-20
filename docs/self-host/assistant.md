---
title: "Set up the assistant"
summary: "Turn on the in-app assistant with an Anthropic or OpenAI key, choose its models, and check that it answers."
read_when:
  - "you want to turn on the assistant for your instance"
  - "you want to change which models people can choose"
  - "you want to offer a model or an effort level Dezfil does not list"
  - "you need to know what the assistant sends to the AI provider"
  - "the assistant pane shows an error instead of an answer"
audience:
  - operator
  - agent
checked: none
order: 4
---

The assistant is a chat pane on the map, SQL and workflow pages. People ask in plain words, and it reads their data and makes changes through Dezfil's own API.

It runs on a key you bring from Anthropic or OpenAI. Until a key is set, the pane only says how to turn it on.

## 1. Get a key

Create an API key in your Anthropic or OpenAI account. The provider bills that account for what the assistant uses.

## 2. Set the key

::::tabs

:::tab[Anthropic]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data \
  -e ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_KEY> \
  dezfil
```

:::

:::tab[OpenAI]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data \
  -e OPENAI_API_KEY=<YOUR_OPENAI_KEY> \
  dezfil
```

:::

::::

The server reads the key when it starts. If Dezfil is already running, run `docker rm -f dezfil` first; the volume keeps your data. With Docker Compose, add the key under `environment:` and run `docker compose up -d`.

The key is set only in the environment: no Settings tab takes it. With both keys set, Dezfil uses Anthropic unless you add `DEZFIL_AI_PROVIDER=openai`.

## 3. Choose the models

The assistant uses a default model: `claude-opus-5` for Anthropic, `gpt-5.6-terra` for OpenAI. Set `DEZFIL_AI_MODEL` to another model id to change it.

People can pick another model and an effort level from the chip beside **Send**. The pick holds for that browser tab. By default the chip lists every model Dezfil knows for your provider:

| Provider | Models offered |
|---|---|
| Anthropic | Opus 5, Fable 5, Sonnet 5, Haiku 4 |
| OpenAI | Astra, Sol, Terra, Nova |

To offer fewer, list their ids in the order you want:

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data \
  -e ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_KEY> \
  -e DEZFIL_AI_MODELS_ANTHROPIC=claude-sonnet-5,claude-haiku-4 \
  dezfil
```

The chip then offers Opus 5, Sonnet 5 and Haiku 4: the default model is always on the list. With one model left, the chip goes and the pane shows that model's id, such as `claude-opus-5`, instead.

## 4. Check that it works

1. Open a map and click **Assistant** in the header. The pane opens with the box **Ask the assistant…**.
2. Type a question, such as "Which datasets can you see?", and click **Send**. You should see an answer in the pane.
3. As an admin, open **Settings** > **System**. The **Assistant** card shows **Status** **On** and the **Provider**.

**On** means a key is set. Only an answer shows the provider accepts it. Agents read the same status from `GET /api/assistant`.

## Offer other models

To offer a model Dezfil does not list, or other effort levels, add a model catalogue file. It is `assistant-models.json`, directly in the data folder:

```json title="assistant-models.json"
{
  "anthropic": [
    { "id": "<MODEL_ID>", "name": "<NAME>", "efforts": ["low", "medium", "high"] }
  ]
}
```

- `anthropic` and `openai` each hold a list of models. Leave out a provider you do not change.
- Each model has exactly `id`, `name` and `efforts`. A model whose `id` Dezfil lists replaces it in its place; a new `id` joins the end of the list.
- `efforts` are the levels the chip offers after **Default**: `low`, `medium`, `high`, `xhigh` or `max` for Anthropic, and `none`, `minimal`, `low`, `medium`, `high` or `xhigh` for OpenAI. An empty list offers **Default** alone.

While `DEZFIL_AI_MODELS_ANTHROPIC` or `DEZFIL_AI_MODELS_OPENAI` is set, a model reaches the chip only if the list names it.

Dezfil reads the file again for each message, so it needs no restart. A pane already open shows the new models once it is opened again. Copy the file in under another name, then rename it, so Dezfil never reads half a file:

```sh title="Terminal"
docker cp assistant-models.json dezfil:/data/assistant-models.json.next
docker exec dezfil mv /data/assistant-models.json.next /data/assistant-models.json
```

Check that Dezfil took it, with an API token from **Settings** > **API & MCP**:

```sh title="Terminal"
curl -s -H "Authorization: Bearer <YOUR_TOKEN>" http://localhost:3000/api/assistant | jq .catalogue
```

```json title="Output"
{
  "source": "merged",
  "instance": "applied"
}
```

`"instance": "rejected"` comes with a `reason`. One mistake rejects the whole file: invalid JSON, an unknown field, a repeated `id`, an effort word the provider does not take, or a file over 256 KiB. The chip then offers the models Dezfil lists until you fix or remove the file.

## Assistant settings

Each of these is a variable, read when the server starts.

<!-- settings-assistant:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Anthropic credential** | `ANTHROPIC_API_KEY` |  | unset | An Anthropic API key | Enables the assistant with this provider. | By variable, after a restart |
| **OpenAI credential** | `OPENAI_API_KEY` |  | unset | An OpenAI API key | Enables the assistant with this provider. | By variable, after a restart |
| **Assistant provider** | `DEZFIL_AI_PROVIDER` |  | first key set | `anthropic` or `openai`; any other value leaves the assistant off | Selects the provider when more than one credential is present. | By variable, after a restart |
| **Assistant model** | `DEZFIL_AI_MODEL` |  | provider default | A model id the provider offers | Overrides the provider's default model. | By variable, after a restart |
| **Anthropic model offer** | `DEZFIL_AI_MODELS_ANTHROPIC` |  | unset | Model ids, separated by commas; set and empty, only the default | Narrows and orders the catalogue; a set empty list offers only the default. | By variable, after a restart |
| **OpenAI model offer** | `DEZFIL_AI_MODELS_OPENAI` |  | unset | Model ids, separated by commas; set and empty, only the default | Narrows and orders the catalogue; a set empty list offers only the default. | By variable, after a restart |
| **Assistant operation offer** | `DEZFIL_ASSISTANT_OFFER` |  | `subset` | `subset` or `full`; any other value reads as `subset` | With subset, the assistant starts with the page's own tools and looks up the rest; with full, it starts with every tool the page allows. | By variable, after a restart |
| **Automatic map check** | `DEZFIL_ASSISTANT_AUTO_CHECK` |  | on | `0`, `false` or `off` turns it off; any other value turns it on | Check the rendered map after an assistant turn changes it. | By variable, after a restart |
| **Assistant steps** | `DEZFIL_ASSISTANT_STEP_BUDGET` |  | `20` steps | Any number above 0 | Maximum model and tool steps per request. | By variable, after a restart |
| **Map check time limit** | `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` |  | `30` seconds | Any number above 0 | Time for one of the assistant's map checks, its wait for a turn included. | By variable, after a restart |
| **Retained map checks** | `DEZFIL_ASSISTANT_LOOK_RETENTION` |  | `256` images | Any number above 0, rounded down to a whole number of at least 1 | Map check pictures kept in memory, oldest dropped first; a restart clears them. | By variable, after a restart |
| **Map check storage** | `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` |  | `96` MB | Any number above 0 | Memory the kept map check pictures may take. | By variable, after a restart |

<!-- settings-assistant:end -->

The image renderer the map check uses is on [Storage and programs](configuration/storage.md). The largest file a tool may hand back is on [Limits](../api/limits.md#limits-an-operator-changes).

## What the provider receives

With each message, Dezfil sends the provider:

- the message and the conversation so far in the pane
- on a map: its layers' names, SQL and style
- on the SQL page: the draft, and the last run's SQL, columns and row count
- on a workflow: its steps and its last run
- up to 32 of the datasets you can see: names, row counts, geometry, and column names and types
- what its actions return, such as the rows of a query it runs
- pictures of the map, when it checks its work

It reads only what the person asking can see. Nothing goes to the provider until someone sends a message.

## Troubleshooting

### The pane says "No model credential is configured"

The server sees no key. In **Settings** > **System** > **Server settings**, check the **Anthropic credential** or **OpenAI credential** row. **Not set** means the variable did not reach the server: pass it with `-e` and replace the container.

### The pane says "Unknown DEZFIL_AI_PROVIDER" or "DEZFIL_AI_PROVIDER is …"

`DEZFIL_AI_PROVIDER` names a provider Dezfil does not support, or one whose key is not set. Correct or remove the variable, or set that provider's key, then restart.

### Sending fails with "The configured Anthropic API key was rejected"

The provider refused the key. With OpenAI, the message names `OPENAI_API_KEY`. Create a new key, set it, and replace the container.

### Sending fails with "The Anthropic API request failed: Connection error."

The server cannot reach the provider. With OpenAI, the message names OpenAI. The server, not the browser, calls `api.anthropic.com` or `api.openai.com` over HTTPS. Allow that connection from the host and the container's network.

### The check line says "This instance cannot take a picture of the map."

The server has no image renderer for the map check. The image ships one; elsewhere, point `DEZFIL_CHROMIUM_PATH` at a headless Chromium, as [Storage and programs](configuration/storage.md) says. Or turn the automatic check off with `DEZFIL_ASSISTANT_AUTO_CHECK=off`.
