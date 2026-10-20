# Dezfil documentation

Every page under `docs/`, generated from the pages' own frontmatter. Find the
section for what you are doing, then the page whose "read when" line is
your situation. The same pages are published at https://dezfil.io/docs/.

This file is written by `npm run docs:write` and held by `npm run lint:docs`:
change the pages, then regenerate it.

## Get started

What Dezfil is, how to install it, and your first map.

- [What Dezfil is](start/what-is-dezfil.md)
  - path: `docs/start/what-is-dezfil.md`
  - summary: See what you can do with Dezfil, what each of its main screens is for, and how an instance runs and keeps your data.
  - read when: you want to know what Dezfil does before you install it; you want to see the main screens and what each one is for; you want to know how Dezfil runs and where it keeps your data; you want to script Dezfil or connect an AI agent to it; you want to know Dezfil's licence
  - audience: user, operator, developer, agent

- [Install](start/install.md)
  - path: `docs/start/install.md`
  - summary: Install Dezfil with Docker, Docker Compose or from source, create the admin account, and keep the instance running day to day.
  - read when: you want Dezfil running on your computer or a server; you choose between Docker, Docker Compose and a development checkout; you create the first admin account; you stop, start, upgrade, back up or check a running instance
  - audience: user, operator, developer

- [Your first map](start/first-map.md)
  - path: `docs/start/first-map.md`
  - summary: Upload a CSV of world cities, put it on a new map, color the points by population and publish the map as a link.
  - read when: you have just installed Dezfil and want to build something; you want to turn a CSV with latitude and longitude columns into points on a map; you want to color points by a column and show a legend; you want to share a map as a link
  - audience: user

## Use Dezfil

Do things in the app: data, maps, SQL, workflows and sharing.

- [Query with SQL](use/sql.md)
  - path: `docs/use/sql.md`
  - summary: Query your datasets in the SQL workspace, see the result as a table or on a map, and keep it as a dataset, a file or a map layer.
  - read when: you want to query your datasets, or ones shared with you, with SQL; you want to see a query result on a map; you want to keep a query result as a dataset, a file or a map layer; a query is refused, fails or takes too long; you want to run SQL from a script or an AI agent
  - audience: user, agent

- [Workflows](use/workflows.md)
  - path: `docs/use/workflows.md`
  - summary: Chain tools on a canvas into a workflow, run it, look at each result and run it again when its data or settings change.
  - read when: you want to repeat the same analysis steps on a dataset without doing them by hand each time; you want to filter, join, buffer or summarize data and keep the result as a dataset; you want to see a step's result as a table or on a map, or add it to a map; you changed a node or its data, or a node says it is edited, stale, failed or cannot run; you can open a workflow someone shared but cannot change or run it
  - audience: user

- [The assistant](use/assistant.md)
  - path: `docs/use/assistant.md`
  - summary: Ask the assistant in plain words to change a map, write SQL into the editor, or explain a workflow node and its last run.
  - read when: you want to change a map by asking in plain words; you want the assistant to write a SQL query, or explain a workflow node or a failed run; the assistant asks you to confirm an action, or you want to stop or undo what it did; you want to choose another model or effort; the assistant pane says no model credential is configured
  - audience: user

- [Your settings](use/settings.md)
  - path: `docs/use/settings.md`
  - summary: Change your look, light or dark, how your lists are laid out and sorted, and your name, email and password.
  - read when: you want another color, typeface, background or panel style, or the side menu always open; you want the dark theme; you want your maps, data, workflows or projects as a list, or sorted another way; you want to change your display name, email or password; you want to know which choices follow you to another browser
  - audience: user

- [Templates](use/templates.md)
  - path: `docs/use/templates.md`
  - summary: The finished maps and workflow examples an instance offers: what a card shows, opening one read only, and making a copy of your own.
  - read when: you want a finished map or workflow example to start from; you want to know where a template's data comes from
  - audience: user

## Self-host

Install, secure, configure and back up your own instance.

- [Configuration](self-host/configuration.md)
  - path: `docs/self-host/configuration.md`
  - summary: Every setting an instance reads, with its default, what it does, and whether it changes live in Settings or needs a restart.
  - read when: you set an environment variable for an instance; you want to know a setting's default; you need to know whether a change applies live or after a restart
  - audience: operator, agent

- [Runbook](self-host/backup-and-restore.md)
  - path: `docs/self-host/backup-and-restore.md`
  - summary: Recipes for the work around an instance: running it locally, backups, upgrades, account recovery, the checks and the outside probes.
  - read when: you back up, restore or upgrade an instance; you recover an admin account; you run the checks, the browser suite or a probe on an instance of your own
  - audience: operator, developer

- [Self-hosting](self-host/what-leaves-the-instance.md)
  - path: `docs/self-host/what-leaves-the-instance.md`
  - summary: What to decide before you put data in an instance, what the instance keeps, and what it sends out.
  - read when: you run an instance for yourself or for others; you put Dezfil behind a reverse proxy; you need to know what leaves the instance
  - audience: operator

## API and agents

Script Dezfil over HTTP, or connect an AI agent through MCP.

- [SQL result limits](api/limits.md)
  - path: `docs/api/limits.md`
  - summary: The fixed byte ceilings on SQL answers, dataset inspection and previews, and what is refused, shortened or still streamed in full.
  - read when: a query or an inspection answers query_result_too_large; you need to know which reads are bounded and by how much
  - audience: user, developer, agent

- [The HTTP API](api/http-api.md)
  - path: `docs/api/http-api.md`
  - summary: How the HTTP API is organised: where its description is served, how sign-in, revisions and errors work, and where the exact rules live.
  - read when: you script Dezfil over HTTP; you look for the operation that does a thing; a request is refused and you want to know why
  - audience: developer, agent

- [The MCP server](api/mcp.md)
  - path: `docs/api/mcp.md`
  - summary: How an AI agent reaches an instance over the Model Context Protocol: the endpoint, sign-in, the generated tools and the agent plugin.
  - read when: you connect an AI agent or MCP client to an instance; you want to know which operations an agent can call; you install the agent plugin
  - audience: user, developer, agent

## Contribute

Work on Dezfil's code.

- [Architecture](contribute/architecture.md)
  - path: `docs/contribute/architecture.md`
  - summary: How the one container is put together: the web application, the metadata database, the query engine and the files under one data directory.
  - read when: you change the code and need to know where a piece lives; you want to know why there is no second service
  - audience: developer, agent

- [Checks and testing](contribute/development-setup.md)
  - path: `docs/contribute/development-setup.md`
  - summary: How to run a checkout for development, the unit and browser suites, and what a full browser run needs provisioned.
  - read when: you set up a checkout to change the code; you run the browser suite against an instance of your own
  - audience: developer

- [How this is built](contribute/how-this-is-built.md)
  - path: `docs/contribute/how-this-is-built.md`
  - summary: The method behind the repository: each change described as behavior first, written largely by AI coding agents and reviewed before it lands.
  - read when: you plan to contribute a change; you wonder why the repository looks the way it does
  - audience: developer

## About

Licence, credits, changes and policies.

## Also

- [Changelog](../CHANGELOG.md) (About): What changed in each release.
- [Security policy](../SECURITY.md) (About): Which versions get fixes and how to report a vulnerability.
- [Contributing to Dezfil](../CONTRIBUTING.md) (Contribute): How to get a change from your machine into the project.
- [Contributor Covenant Code of Conduct](../CODE_OF_CONDUCT.md) (Contribute): The standards for taking part and how they are enforced.
- [The OpenAPI description](api/openapi.json) (API and agents): the HTTP API as the server serves it, generated from the source; the operation reference is built from it.
- [The image manifest](images/manifest.json): one row per picture and recording, each scene in its light and its dark take, with the scene it shows, the take's theme, its size and when it was taken.
