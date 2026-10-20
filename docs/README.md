# Dezfil documentation

Every page under `docs/`, generated from the pages' own frontmatter. Find the
section for what you are doing, then the page whose "read when" line is
your situation. `checked` is the release a page was last read against a
running instance of, with the date, or `none` until it has been. The same
pages are published at https://dezfil.io/docs/.

This file is written by `npm run docs:write` and held by `npm run lint:docs`:
change the pages, then regenerate it.

## Get started

What Dezfil is, how to install it, and your first map.

- [Run it](start/install.md)
  - path: `docs/start/install.md`
  - summary: The two ways to run Dezfil, where everything it stores lives, and the first-run setup that creates the admin account.
  - read when: you run Dezfil for the first time; you choose between the container and a development checkout; you back up or move an instance's data
  - audience: user, operator
  - checked: none

## Use Dezfil

Do things in the app: data, maps, SQL, workflows and sharing.

- [Templates](use/templates.md)
  - path: `docs/use/templates.md`
  - summary: The finished maps and workflow examples an instance offers: what a card shows, opening one read only, and making a copy of your own.
  - read when: you want a finished map or workflow example to start from; you want to know where a template's data comes from
  - audience: user
  - checked: none

## Self-host

Install, secure, configure and back up your own instance.

- [Configuration](self-host/configuration.md)
  - path: `docs/self-host/configuration.md`
  - summary: Every setting an instance reads, with its default, what it does, and whether it changes live in Settings or needs a restart.
  - read when: you set an environment variable for an instance; you want to know a setting's default; you need to know whether a change applies live or after a restart
  - audience: operator, agent
  - checked: none

- [Runbook](self-host/backup-and-restore.md)
  - path: `docs/self-host/backup-and-restore.md`
  - summary: Recipes for the work around an instance: running it locally, backups, upgrades, account recovery, the checks and the outside probes.
  - read when: you back up, restore or upgrade an instance; you recover an admin account; you run the checks, the browser suite or a probe on an instance of your own
  - audience: operator, developer
  - checked: none

- [Self-hosting](self-host/what-leaves-the-instance.md)
  - path: `docs/self-host/what-leaves-the-instance.md`
  - summary: What to decide before you put data in an instance, what the instance keeps, and what it sends out.
  - read when: you run an instance for yourself or for others; you put Dezfil behind a reverse proxy; you need to know what leaves the instance
  - audience: operator
  - checked: none

## API and agents

Script Dezfil over HTTP, or connect an AI agent through MCP.

- [SQL result limits](api/limits.md)
  - path: `docs/api/limits.md`
  - summary: The fixed byte ceilings on SQL answers, dataset inspection and previews, and what is refused, shortened or still streamed in full.
  - read when: a query or an inspection answers query_result_too_large; you need to know which reads are bounded and by how much
  - audience: user, developer, agent
  - checked: none

- [The HTTP API](api/http-api.md)
  - path: `docs/api/http-api.md`
  - summary: How the HTTP API is organised: where its description is served, how sign-in, revisions and errors work, and where the exact rules live.
  - read when: you script Dezfil over HTTP; you look for the operation that does a thing; a request is refused and you want to know why
  - audience: developer, agent
  - checked: none

- [The MCP server](api/mcp.md)
  - path: `docs/api/mcp.md`
  - summary: How an AI agent reaches an instance over the Model Context Protocol: the endpoint, sign-in, the generated tools and the agent plugin.
  - read when: you connect an AI agent or MCP client to an instance; you want to know which operations an agent can call; you install the agent plugin
  - audience: user, developer, agent
  - checked: none

## Contribute

Work on Dezfil's code.

- [Architecture](contribute/architecture.md)
  - path: `docs/contribute/architecture.md`
  - summary: How the one container is put together: the web application, the metadata database, the query engine and the files under one data directory.
  - read when: you change the code and need to know where a piece lives; you want to know why there is no second service
  - audience: developer, agent
  - checked: none

- [Checks and testing](contribute/development-setup.md)
  - path: `docs/contribute/development-setup.md`
  - summary: How to run a checkout for development, the unit and browser suites, and what a full browser run needs provisioned.
  - read when: you set up a checkout to change the code; you run the browser suite against an instance of your own
  - audience: developer
  - checked: none

- [How this is built](contribute/how-this-is-built.md)
  - path: `docs/contribute/how-this-is-built.md`
  - summary: The method behind the repository: each change described as behavior first, written largely by AI coding agents and reviewed before it lands.
  - read when: you plan to contribute a change; you wonder why the repository looks the way it does
  - audience: developer
  - checked: none

## About

Licence, credits, changes and policies.

## Also

- [Changelog](../CHANGELOG.md) (About): What changed in each release.
- [Security policy](../SECURITY.md) (About): Which versions get fixes and how to report a vulnerability.
- [Contributing to Dezfil](../CONTRIBUTING.md) (Contribute): How to get a change from your machine into the project.
- [Contributor Covenant Code of Conduct](../CODE_OF_CONDUCT.md) (Contribute): The standards for taking part and how they are enforced.
- [The OpenAPI description](reference/openapi.json) (Reference): the HTTP API as the server serves it, generated from the source; the operation reference is built from it.
- [The image manifest](images/manifest.json): one row per picture and recording, each scene in its light and its dark take, with the scene it shows, the take's theme, its size and when it was taken.
