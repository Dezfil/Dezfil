---
title: "Configuration"
summary: "Change your instance's settings in the app or with environment variables, and check which value is in effect."
read_when:
  - "you want to change how your instance behaves"
  - "you set an environment variable and want to check that it took effect"
  - "you want to know whether a change applies at once or after a restart"
  - "you look for a setting's default or the values it takes"
audience:
  - operator
  - agent
checked: none
order: 3
moved_from:
  - "/docs/reference/configuration/"
---

You change a setting in one of two places:

| Where | How | When it applies |
|---|---|---|
| **Settings** in the app | Sign in as an admin, open **Settings** and pick a tab under **Instance** | At once, for new work |
| An environment variable | Pass it when the server starts | After a restart |

## Set a variable

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data \
  -e DEZFIL_UPLOAD_MAX_MB=10240 \
  -e DEZFIL_QUERY_TIMEOUT_S=120 \
  ghcr.io/dezfil/dezfil
```

A container keeps the variables it was created with. To change one, first list the ones it has:

```sh title="Terminal"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' dezfil
```

The list holds the image's own variables too, such as `PATH` and `DEZFIL_DATA_DIR`. Run `docker rm -f dezfil`, then the command again with every variable you set, not only the new one, `DEZFIL_SECRET_KEY` too if you set one. The `dezfil-data` volume keeps your data.

Without `DEZFIL_SECRET_KEY`, the instance's key is the `secret.key` file in its volume, once Dezfil has made one. To set the variable, print that key as [Keep the key you have](docker-compose.md#keep-the-key-you-have) shows, and pass it as `-e DEZFIL_SECRET_KEY=<64_HEX_CHARACTERS>`. [Storage and programs](configuration/storage.md) says what another key breaks.

:::

:::tab[Docker Compose]

Add the variables to the service in your `compose.yaml`:

```yaml title="compose.yaml"
services:
  dezfil:
    environment:
      DEZFIL_UPLOAD_MAX_MB: "10240"
      DEZFIL_QUERY_TIMEOUT_S: "120"
```

Then run `docker compose up -d`. Compose replaces the container and keeps the volume.

Keep keys such as `ANTHROPIC_API_KEY` out of `compose.yaml`: [Docker Compose](docker-compose.md#3-make-the-keys-file) puts them in a `.env` file.

:::

::::

- `DEZFIL_UPLOAD_MAX_MB` raises the largest upload to 10,240 MB.
- `DEZFIL_QUERY_TIMEOUT_S` gives each query up to 120 seconds.

You should see, in **Settings** > **Limits**, the **Largest upload** row locked with the line **Set in the server's environment by `DEZFIL_UPLOAD_MAX_MB`.**

A provider key for the assistant is set the same way: see [Set up the assistant](assistant.md). To build the image and run it the first time, see [Install](../start/install.md).

## Which value wins

1. A variable that is set and not empty wins. Its row in Settings is locked.
2. Otherwise, the value an admin saved in Settings.
3. Otherwise, the default.

A saved value stays saved while a variable overrides it. It applies again once you remove the variable and restart.

A number Dezfil cannot use still locks the row, and the default applies. The row then says, for example, **`DEZFIL_UPLOAD_MAX_MB` in the server's environment is not valid, so the default is used.**

Some settings live in one place only. What new maps start with and who may publish are in Settings alone. The data folder, the encryption key and the assistant's key are variables alone.

> [!NOTE]
> Remove a variable to return to its default. Set but empty, `DEZFIL_DATA_DIR`, `DEZFIL_TIPPECANOE`, `DEZFIL_CHROMIUM_PATH` and `DEZFIL_AI_MODEL` are used as they are, `DEZFIL_AI_PROVIDER` turns the assistant off and `DEZFIL_SESSION_COOKIE` keeps Dezfil from starting.

In Settings, choices save as you change them, and a typed number when you press Enter or leave the field. Other typed text waits for **Save**. Work already running keeps the value it started with.

## See the values in effect

Open **Settings** > **System**. The **Server settings** card lists every setting a variable can set, with its **Value** and **Source**: **Environment**, **Default**, or where an admin saved it.

API keys show only **Set** or **Not set**, and service addresses only their scheme and host.

The card also lists variables that set no instance setting: the platform's own, such as `PORT`, and one the development setup uses. [Development setup](../contribute/development-setup.md#variables-the-platform-sets) explains them.

Agents read the same values, as an admin, from `GET /api/instance/settings`. They change a setting with `PATCH /api/instance/settings`, under the Settings key its table names. A setting a variable locks answers `409 setting_locked`. [How the API works](../api/http-api.md) covers tokens and requests.

## Settings tables

Every setting has one row, in the table of its area. A row gives the variable and the Settings key, the default with its unit, the values it takes, what it does and how a change applies.

| Table | What it covers | Where to change it |
|---|---|---|
| [General](configuration/general.md) | The instance's name, the sign-in message, the lost-password contact and the landing page | **General** |
| [Instance defaults](configuration/defaults.md) | What new maps, layers, workflow canvases, SQL consoles and image exports start with | **Maps**, **Workflows & SQL**, **Publishing** |
| [Basemaps and imagery](configuration/libraries.md) | The basemaps on offer, satellite imagery and the deployment's own basemap | **Libraries**, or a variable |
| [Data and services](configuration/services.md) | The address finder, travel time, OpenStreetMap, S3 storage, the template catalogue and hosts on your own network | **Data & services**, or a variable |
| [Security and rules](configuration/rules.md) | Sign-in and link lifetimes, passwords, and who may create tokens, publish, embed, connect and import | **Security**, **Publishing**, **Data & services** |
| [Storage and programs](configuration/storage.md) | The data folder, the encryption key, the tile builder and the image renderer | A variable |
| [Set up the assistant](assistant.md#assistant-settings) | The provider keys, the models on offer and the assistant's own budgets | A variable |
| [Reverse proxy and HTTPS](reverse-proxy.md#trusted-proxies) | The trusted proxies and the session cookie's name | A variable |
| [Limits](../api/limits.md#limits-an-operator-changes) | Time, size, memory, rate and queue limits | **Limits**, or a variable |

## What else is kept

- Each person's look, list layouts and sort orders are their own account preferences, kept with their account. They are not instance settings. [Your settings](../use/settings.md) shows where each is changed.
- The model catalogue file, `assistant-models.json` in the data folder, adds models people can choose. See [Offer other models](assistant.md#offer-other-models).
- Saved palettes and the basemap styles an admin adds are instance data, kept on the **Libraries** tab.
