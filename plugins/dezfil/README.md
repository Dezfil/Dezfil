# Dezfil for Claude Code and Codex

This package connects a local client to a running Dezfil instance and adds
the Dezfil skill, shared analytical guidance and two compact references.
The client supplies its model. The connection needs no Dezfil model key or
token. Installing the package publishes no map or service.

Prerequisites: a reachable Dezfil instance, Node.js 24 or newer, and a client
with local plugin support. Local catalog registration, plugin installation,
status and package or catalog removal have been exercised with isolated
settings on both supported clients; each installed the skill files and resolved
the selected endpoint.

## Prepare a local source

From a Dezfil checkout, choose a new directory and the instance address:

```sh
node scripts/prepare-dezfil-plugin.mjs \
  --output "$HOME/dezfil-local" \
  --base-url http://localhost:3000
```

Omitting `--base-url` selects `http://localhost:3000`. HTTP and HTTPS origins,
nondefault ports, IPv6 hosts, a trailing slash and the complete `/api/mcp`
endpoint are accepted. Other paths, credentials, queries, fragments and invalid
URLs are refused before writing configuration. An occupied destination is
refused. The prepared directory contains a self-contained copy with the chosen
literal endpoint and local catalogs for both clients.

The deliverable is `plugins/dezfil/`; the prepared copy can live outside the
checkout. Its references and guidance remain readable there.

## Claude Code

```sh
claude plugin marketplace add "$HOME/dezfil-local"
claude plugin install dezfil@dezfil-local --scope user
```

If this client already has the standalone `dezfil` connection added from
Dezfil's Developer guide, remove that standalone entry as part of the
transition:

```sh
claude mcp remove dezfil
```

Start a fresh Claude Code conversation. Open `/mcp`, check the instance URL and
the one active Dezfil connection under the client's plugin namespace, then
open its tool listing. Invoke `/dezfil:dezfil` for a map task and open the
two reference links from the installed skill.

## Codex CLI

```sh
codex plugin marketplace add "$HOME/dezfil-local"
codex plugin add dezfil@dezfil-local
```

If the Developer guide previously added the standalone `dezfil` entry in
this client, remove it during the transition:

```sh
codex mcp remove dezfil
```

Start a fresh Codex conversation. Open `/mcp`, check the chosen instance and
the one active Dezfil connection under the client's plugin namespace, and
inspect its tool listing. Select the Dezfil skill for a map task and open
both installed references. The native client's displayed connection identity
is the status check; plugin and standalone connections have different names.

## Change the instance or remove the package

To change the instance, prepare a new directory with the new address. Remove
the existing package and its `dezfil-local` catalog registration, then repeat
the appropriate installation commands using the new directory. Fresh
conversations pick up the new installed copy.

Claude Code removal:

```sh
claude plugin uninstall dezfil@dezfil-local --scope user
claude plugin marketplace remove dezfil-local
```

Codex CLI removal:

```sh
codex plugin remove dezfil@dezfil-local
codex plugin marketplace remove dezfil-local
```

These commands address the Dezfil package and its catalog. Other plugin,
skill and client settings have their own registrations. Compare those settings
before and after the native install when recording installation evidence.

## Package contents

The two native manifests share `.mcp.json`. The generated `analysis.md` comes
from Dezfil's canonical analytical guidance, with separate external grounding.
`references/cartography.md` and `references/duckdb-spatial.md` contain the
bounded references and executable examples. `NOTICE`, `sources.json`,
`LICENSE` and `LICENSE-GeoSQL` carry the source and license inventory.

The source formats are documented in the
[Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)
and [OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins).
