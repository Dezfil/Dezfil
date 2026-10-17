# Dezfil documentation

Every page under `docs/`, generated from the pages' own frontmatter. Find the
section for what you are doing, then the page whose "read when" line is
your situation. `checked` is the release a page was last read against a
running instance of, with the date, or `none` until it has been. The same
pages are published at https://dezfil.io/docs/.

This file is written by `npm run docs:write` and held by `npm run lint:docs`:
change the pages, then regenerate it.

## Start

What Dezfil is and your first map.

- [Run it](start/run-it.md)
  - path: `docs/start/run-it.md`
  - summary: The two ways to run Dezfil, where everything it stores lives, and the first-run setup that creates the admin account.
  - read when: you run Dezfil for the first time; you choose between the container and a development checkout; you back up or move an instance's data
  - audience: user, operator
  - checked: none

## Guides

How to do each thing in the app.

- [Templates](guides/templates.md)
  - path: `docs/guides/templates.md`
  - summary: The finished maps and workflow examples an instance offers: what a card shows, opening one read only, and making a copy of your own.
  - read when: you want a finished map or workflow example to start from; you want to know where a template's data comes from
  - audience: user
  - checked: none

## Reference

The exact rules: the API, MCP, configuration, limits, formats, shortcuts.

- [Configuration](reference/configuration.md)
  - path: `docs/reference/configuration.md`
  - summary: Every setting an instance reads, with its default, what it does, and whether it changes live in Settings or needs a restart.
  - read when: you set an environment variable for an instance; you want to know a setting's default; you need to know whether a change applies live or after a restart
  - audience: operator, agent
  - checked: none

- [SQL result limits](reference/sql-limits.md)
  - path: `docs/reference/sql-limits.md`
  - summary: The fixed byte ceilings on SQL answers, dataset inspection and previews, and what is refused, shortened or still streamed in full.
  - read when: a query or an inspection answers query_result_too_large; you need to know which reads are bounded and by how much
  - audience: user, developer, agent
  - checked: none

- [The HTTP API](reference/http-api.md)
  - path: `docs/reference/http-api.md`
  - summary: How the HTTP API is organised: where its description is served, how sign-in, revisions and errors work, and where the exact rules live.
  - read when: you script Dezfil over HTTP; you look for the operation that does a thing; a request is refused and you want to know why
  - audience: developer, agent
  - checked: none

- [The MCP server](reference/mcp.md)
  - path: `docs/reference/mcp.md`
  - summary: How an AI agent reaches an instance over the Model Context Protocol: the endpoint, sign-in, the generated tools and the agent plugin.
  - read when: you connect an AI agent or MCP client to an instance; you want to know which operations an agent can call; you install the agent plugin
  - audience: user, developer, agent
  - checked: none

## Operate

Running an instance.

- [Runbook](operate/runbook.md)
  - path: `docs/operate/runbook.md`
  - summary: Recipes for the work around an instance: running it locally, backups, upgrades, account recovery, the checks and the outside probes.
  - read when: you back up, restore or upgrade an instance; you recover an admin account; you run the checks, the browser suite or a probe on an instance of your own
  - audience: operator, developer
  - checked: none

- [Self-hosting](operate/self-hosting.md)
  - path: `docs/operate/self-hosting.md`
  - summary: What to decide before you put data in an instance, what the instance keeps, and what it sends out.
  - read when: you run an instance for yourself or for others; you put Dezfil behind a reverse proxy; you need to know what leaves the instance
  - audience: operator
  - checked: none

## Develop

Changing the code.

- [Architecture](develop/architecture.md)
  - path: `docs/develop/architecture.md`
  - summary: How the one container is put together: the web application, the metadata database, the query engine and the files under one data directory.
  - read when: you change the code and need to know where a piece lives; you want to know why there is no second service
  - audience: developer, agent
  - checked: none

- [Checks and testing](develop/checks-and-testing.md)
  - path: `docs/develop/checks-and-testing.md`
  - summary: How to run a checkout for development, the unit and browser suites, and what a full browser run needs provisioned.
  - read when: you set up a checkout to change the code; you run the browser suite against an instance of your own
  - audience: developer
  - checked: none

- [How this is built](develop/how-this-is-built.md)
  - path: `docs/develop/how-this-is-built.md`
  - summary: The method behind the repository: each change described as behavior first, written largely by AI coding agents and reviewed before it lands.
  - read when: you plan to contribute a change; you wonder why the repository looks the way it does
  - audience: developer
  - checked: none

### Verification

- [Accepted deletion admission proofs](develop/verification/account-deletion-admission.md)
  - path: `docs/develop/verification/account-deletion-admission.md`
  - summary: Proofs on a built candidate that pages stop serving a deleted owner's content and that deletion survives a restart.
  - read when: you change what happens to admitted work when an account is deleted
  - audience: developer
  - checked: none

- [Account deletion on the built application](develop/verification/account-deletion-image.md)
  - path: `docs/develop/verification/account-deletion-image.md`
  - summary: Proofs that account deletion erases rows, files and the store's free pages on the built application and in the container image.
  - read when: you change account deletion and need the built-image evidence
  - audience: developer
  - checked: none

- [Account deletion operations and surfaces](develop/verification/account-deletion-surfaces.md)
  - path: `docs/develop/verification/account-deletion-surfaces.md`
  - summary: Proofs over the deletion operations through session, token, MCP and the assistant, and over the Users screen that drives them.
  - read when: you change the account deletion operations or their screens
  - audience: developer
  - checked: none

- [Account erasure inventory](develop/verification/account-erasure-inventory.md)
  - path: `docs/develop/verification/account-erasure-inventory.md`
  - summary: The closed list of what account deletion erases, purges, compacts or retains, and the populated proofs that hold it.
  - read when: you add a table, file or holder that stores an account's data
  - audience: developer
  - checked: none

- [Account store compaction proof](develop/verification/account-compaction.md)
  - path: `docs/develop/verification/account-compaction.md`
  - summary: How to prove that compacting the shared account store after a deletion finishes in place while a separate process keeps probing the server.
  - read when: you change account deletion or the metadata store's compaction
  - audience: developer
  - checked: none

- [Provider cancellation probes](develop/verification/provider-cancellation.md)
  - path: `docs/develop/verification/provider-cancellation.md`
  - summary: Probes that place search and basemap inspection stop their outbound calls when the caller leaves or replaces the request.
  - read when: you change the geocoder, basemap inspection or how a request is cancelled
  - audience: developer
  - checked: none

- [Renderer destination probes](develop/verification/render-egress-probes.md)
  - path: `docs/develop/verification/render-egress-probes.md`
  - summary: Probes that the image export renderer reaches only the destinations it may, from the image job's gate to the wider matrix.
  - read when: you change where the image export renderer may connect
  - audience: developer
  - checked: none

- [Served reader and tool contract](develop/verification/account-deletion-guidance.md)
  - path: `docs/develop/verification/account-deletion-guidance.md`
  - summary: A probe that compares the served API description and MCP tool list with the counts and error catalogue the guides state.
  - read when: you change the API description, the error catalogue or the generated tools; the reader counts in the API or MCP guide disagree with the contract
  - audience: developer
  - checked: none

- [TLS, browser transport and paired render timing](develop/verification/render-comparison-probes.md)
  - path: `docs/develop/verification/render-comparison-probes.md`
  - summary: Outside probes for image exports: private certificate trust, the browser transport and paired render timing against a baseline image.
  - read when: you change the image export renderer or its relay and need timing evidence
  - audience: developer
  - checked: none

- [Upgrade and recovery after deleting the original account](develop/verification/account-deletion-recovery.md)
  - path: `docs/develop/verification/account-deletion-recovery.md`
  - summary: Proofs that an upgraded store keeps working, and an admin can still be recovered, after the original account is deleted.
  - read when: you change account upgrade, setup or admin recovery
  - audience: developer
  - checked: none

## About

Licence, credits, changes and policies.

## Also

- [Changelog](../CHANGELOG.md) (About): What changed in each release.
- [Security policy](../SECURITY.md) (About): Which versions get fixes and how to report a vulnerability.
- [Contributing to Dezfil](../CONTRIBUTING.md) (Develop): How to get a change from your machine into the project.
- [Contributor Covenant Code of Conduct](../CODE_OF_CONDUCT.md) (Develop): The standards for taking part and how they are enforced.
- [The OpenAPI description](reference/openapi.json) (Reference): the HTTP API as the server serves it, generated from the source; the operation reference is built from it.
- [The image manifest](images/manifest.json): one row per picture and recording, with the scene it shows, its size and when it was taken.
