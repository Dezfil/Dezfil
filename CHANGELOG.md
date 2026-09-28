# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Breaking: application pages and API operations now require a current cookie
  session or an account bearer token, including configuration, OpenAPI, MCP,
  assistant and exports. Anonymous API clients receive `authentication_required`.
  Published token-scoped reads, viewer/embed, readiness and entry remain public.
  Complete first-account setup and create client tokens in Settings.
  Cookie mutations require the instance Origin. Shared resource access between
  signed-in accounts is unchanged; account administration requires an admin.

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
- An HTTP API covering every capability the interface uses, an MCP server over
  the same surface, and a packaged plugin for MCP clients.
- A single container image that runs the whole application offline, with the
  spatial extensions baked in.

[Unreleased]: https://github.com/Dezfil/Dezfil/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Dezfil/Dezfil/releases/tag/v0.1.0
