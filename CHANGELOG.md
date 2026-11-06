# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

### Added

- Sign-in through a trusted outside service, off by default. With it on, the
  instance takes a signed, single-use ticket from a sign-in service you run,
  and refuses its own passwords and sign-in links. The first owner is named in
  the configuration, so an empty instance cannot be claimed, and an invitation
  carries no credential until a ticket for that email arrives. The self-host
  docs have the configuration page and a guide to writing such a service.
- **Sign everyone out**, in **Settings** > **Security**: it ends every
  session, API token and assistant work begun before it, in either sign-in
  mode.
- A door generation reset, `DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET`, for
  when the sign-in service's signing key leaks. Applied once per value at
  start, it ends every session and token and lets the real service in again.
  Admins see the last applied reset on the External sign-in card.
- The assistant on a person's own Anthropic or OpenAI key, set in
  **Settings** > **Assistant**, beside or instead of the instance's key. The
  key is kept encrypted, never shown again, readable by no admin and sent
  only to its provider. The model line says whose key answers, and a
  rejected key names who must replace it. New operations
  `GET`, `PUT` and `DELETE /api/account/assistant-key`, with the tools
  `get_assistant_key`, `set_assistant_key` and `remove_assistant_key`.
- Instance limits, in **Settings** > **Limits**: how many maps, projects and
  people one instance holds, and the longest token lifetime. All are off by
  default, and can be locked with `DEZFIL_MAPS_LIMIT`,
  `DEZFIL_PROJECTS_LIMIT`, `DEZFIL_PEOPLE_LIMIT` and
  `DEZFIL_TOKEN_LIFETIME_MAX`. Creating past a limit answers
  `instance_limit_reached` with the limit and the count. Lowering a limit
  deletes nothing.
- A clear answer on a full disk. At 512 MB free or less on the data volume,
  uploads, imports, conversions, exports and other new file work answer
  `409 storage_full` and write nothing. A write the volume refuses answers
  `507 storage_exhausted` and leaves no partial file. A 64 MB reserve keeps
  signing in, signing out, revoking and deleting working, so space can be
  freed. Data, Add data and the Storage card say when storage is full.
- A classed paint carries `wholeNumbers`: whether the result it classified
  is a whole-number type. On whole numbers the legend names what each class
  holds: breaks 1, 2, 3 read "≤ 1", "2", "3", "> 3", and breaks 4, 14
  read "≤ 4", "5 – 14", "> 14". Computing classes sets it; a layer write
  that changes the SQL or the aggregation without sending a paint removes
  it from the stored paints the server does not recompute. An additive
  change to the paint in the API description.
- A field's statistics read takes `distribution=classification`: the
  values a classification sees, filters applied and an aggregated layer's
  `value` or `count`, binned equal on a log axis for skewed positive values
  and a linear one otherwise, with the bin `edges`, the `axis` and the
  field's `wholeNumbers`. Without it the read answers as before.

- Opening a map, workflow, dataset, project or template you cannot reach
  names the kind, as in "Map not found" with **Go to Maps**. A missing item
  and one you cannot reach read the same.

### Changed

- A classed colour's legend reads each class as what it holds: the first
  "≤" its boundary, the last ">" the one below it, a value equal to a
  boundary in the lower class. It read "<" and "≥", which named the first
  class's top value as outside it. Class boundaries show every digit they
  need, in the legend and in the Style panel's boundary fields.
- The Style panel's histogram for a classed colour draws the values its
  classification sees, on the read's axis: skewed counts spread out on a
  log axis, each bar takes the colour of the class it holds, and handles
  that would overlap stagger above and below the track. A released handle
  on whole numbers lands on the nearest whole number that keeps the order.
- A new classed colour starts on Natural breaks over whole numbers, such as
  counts, and on Quantile over any other number: on picking a numeric
  column, on switching Continuous to Classified, and on cells made with no
  numeric colour to carry. Where Natural cannot classify the values, all
  of them equal, it starts on Quantile. A method you pick or a layer
  already holds is kept, and the classification request still takes the
  method it is given.

- Each account holds at most two unsubmitted assistant reservations and four
  running turns, so one account cannot hold the assistant from the others.
- The screens before sign-in no longer show a coordinate in the picture's
  corner.
- Updated libraries, among them the spatial engine's Node client to DuckDB
  1.5.6, better-sqlite3 13, the OpenAI SDK 7 and the Anthropic SDK 0.135.

### Upgrading from 0.1.0

- Compatibility: an instance whose data volume has 512 MB free or less
  refuses uploads, imports, conversions and exports after the upgrade, with
  `storage_full`, until space is freed. The instance also keeps 64 MB of the
  volume in a reserve file.
- Compatibility: the assistant status read answers per caller, with
  `instanceKey` and `payer`. A turn reservation is no longer refused for
  capacity; the turn is refused when it starts instead.
- Compatibility: a classed colour's legend reads "≤" and ">" where it read
  "<" and "≥".
- Compatibility: on its first start this version adds tables to the metadata
  database, for personal assistant keys and the outside sign-in service. To
  go back to 0.1.0, restore the backup taken before the upgrade, as Upgrade
  says.

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

[Unreleased]: https://github.com/Dezfil/Dezfil/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Dezfil/Dezfil/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Dezfil/Dezfil/releases/tag/v0.1.0
