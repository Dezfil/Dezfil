# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

First public release.

### Added

- Upload geospatial files and keep them as durable tables, with large sets
  served as vector tiles.
- A SQL workspace over a server-side spatial engine, where a query is the
  source of truth for a map layer.
- A map builder on a vector basemap: layers, styling, colormaps, an editable
  legend, interactivity, and drawing on the map.
- Workflows that chain the spatial operations into a repeatable pipeline.
- Read-only connections to a PostGIS database.
- Publishing a map as a shareable view, and exporting it as an image.
- Local accounts: the first one is the admin, each account's maps, workflows
  and datasets are private to it, and a project's owner shares the project
  with other accounts as viewers or editors.
- Templates: finished maps and workflow examples on open data, to open or
  copy.
- An assistant on the map, SQL and workflow pages, running on an Anthropic or
  OpenAI key set on the server.
- Map card pictures drawn on the server from each map's saved state.
- An HTTP API covering every capability the interface uses, an MCP server over
  the same surface, and a packaged plugin for MCP clients.
- A single container image that runs the whole application offline, with the
  spatial extensions baked in, published as `ghcr.io/dezfil/dezfil` for
  `linux/amd64` and `linux/arm64`.

### Upgrading from an earlier build

These notes are for an instance that ran a build from before this release.

- Breaking: application pages and API operations now require a current cookie
  session or an account bearer token, including configuration, OpenAPI, MCP,
  assistant and exports. Anonymous API clients receive `authentication_required`.
  Published token-scoped reads, viewer/embed, readiness and entry remain public.
  Complete first-account setup and create client tokens in Settings.
  Cookie mutations require the instance Origin. Account administration
  requires an admin.
- Breaking: user SQL refuses file readers, file-relation shorthand and engine
  path or definition discovery with `sql_rejected`, even for a file its author
  owns. File-referencing PROJ coordinate definitions are refused too; EPSG
  codes and inline definitions without files still work. Saved queries and
  published layers that use them fail until their owner changes the SQL to
  name an uploaded dataset. Review saved queries before you upgrade.
- Breaking: a client that changes a map or a workflow, its layers and steps
  included, sends the edit revision it last read in `X-Edit-Revision`. A change
  without one answers `400 invalid_request`, and one sent with an older
  revision answers `409 stale_revision`. Deleting a layer and unpublishing a map
  answer with JSON that carries the map's next revision, where they answered
  with no body.
- Compatibility: `PUT /api/maps/{id}/thumbnail` now refuses authorized browser
  uploads with `410 picture_upload_retired`. Use
  `POST /api/maps/{id}/picture/refresh`. Reading existing pictures is unchanged.
- Compatibility: SQL drafts and history that a browser kept before accounts
  belong to no account, so they are discarded the first time an account signs
  in there. Copy any draft you need before you upgrade. From then on, signing
  out or signing in as another account clears them in that browser. Saved
  layer and workflow SQL is unaffected.
- Compatibility: on its first start, this version gives every map, dataset,
  workflow, connection and project to the recorded original account, the one
  made at setup, even when another account is the admin or it is deactivated.
  With no account yet, setup gives them to the account it makes, so keep the
  instance private until you have made it. Other accounts start with nothing
  of their own, and every project keeps its owner, with no members until its
  owner adds people. Dataset and connection names need to be unique only
  within one owner's work, so two accounts can each have a `roads`.
- Compatibility: each account gets a SQL name, made from its display name and
  kept when the name changes. A deleted account keeps its SQL name for good, so
  SQL that names it never reaches an account made later. Each map and workflow
  takes its owner's SQL name as its SQL home, so a plain dataset name in its
  SQL means that account's dataset, whoever opens it. Saved SQL that names
  `main.<table>`, `memory.<table>` or `memory.main.<table>` keeps working.
- Compatibility: maps and workflows show **Unknown** as the author of the
  changes made before this version. Changes after it name the account that
  made them.

[Unreleased]: https://github.com/Dezfil/Dezfil/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Dezfil/Dezfil/releases/tag/v0.1.0
