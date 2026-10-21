---
title: "Runbook"
summary: "Recipes for the work around an instance: its data directory, backups, upgrades, account recovery and deletion, and API clients without a browser."
read_when:
  - "you back up, restore or upgrade an instance"
  - "you recover an admin account"
  - "you finish deleting an account, or drive the API from a shell script"
audience:
  - operator
  - developer
checked: none
moved_from:
  - "/docs/operate/runbook/"
---

Operational recipes for running a self hosted instance: the things an owner
does around the container rather than inside the app. Each section stands on
its own and names the settings it touches. More recipes are added here as
they are written down.

## The data directory

All durable state lives in one directory. `DEZFIL_DATA_DIR` names it;
unset, it defaults to `./data` under the working directory, and the image
sets `/data`. Back up that directory with the instance stopped and preserve any
externally supplied encryption key.

What appears inside it as the instance is used: `metadata.sqlite` (maps,
layers, styles, published links, connections, accounts, sessions, token records,
workflows and runs), `tables/` (the GeoParquet
artifacts), `thumbnails/`, `tmp/` (scratch for imports, exports and tile
builds), `cache/overpass/` once an OSM import runs, and `secret.key` on
first boot unless `DEZFIL_SECRET_KEY` was set first. It also holds `tiles/`
(one PMTiles archive per tiled layer), `exports/` (project exports being
assembled), the provider caches `cache/geocode/` and `cache/isochrone/`, and
`artifact-inputs/` (what each tile archive and map card picture drew). An optional
`assistant-models.json` placed there by hand is read as
[Set up the assistant](assistant.md#offer-other-models) describes.

## Upgrading ownership storage

Stop the instance and back up the complete data directory before upgrading,
including SQLite journal files, artifacts and `secret.key`. Preserve any
externally configured encryption key as well. Rehearse the upgrade on a copy.

The upgrade assigns existing maps, datasets, workflows, connections, projects
and operation job records to the recorded original account, even when another
account is now admin or the original account is deactivated. An installation
without accounts keeps these records pending until first-account setup. Setup
adopts them in the same transaction as the account, preferences and session.
Failed adoption rolls back and can be retried. Existing identities, SQL,
public links, credentials, memberships and artifact paths are preserved.
Other accounts start with their own empty space. An admin flag does not grant
access to the original account's content or a way to reassign it: only an
owner can transfer their project, map or workflow, to someone it is already
shared with. Deactivation freezes private work; reactivation restores access to
the same records. Existing published links keep their read-only projection.
New resources take their owner from the authenticated creator; request fields
cannot assign a different owner. Dataset and connection names are unique within
that owner; two accounts may use the same names and keep distinct identities.
After duplicate names exist across accounts, an older build with global name
constraints cannot read that store safely. Restore its matching backup as well.

Restore the matching old application and the complete pre-upgrade backup to
roll back. A build predating ownership or sharing cannot safely write those upgraded stores.
The later edit-revision additions alone remain compatible with the immediately
preceding writers. That compatibility does not replace a rollback backup.
Account for work written after the backup before restoring it.

The project-sharing storage upgrade takes the same backup. It gives every
account a SQL name, derived from the display name (else the email's local
part, else `user`, with a number added on a collision or on a name the query
engine reserves) and fixed from then on. It marks each map and workflow with
its owner's space as its SQL home, and records which account started each
workflow run and produced each step output. Nothing is shared by it: every
project keeps its owner and has no members. An installation still awaiting
first-account setup receives the homes and run records in the setup
transaction. The upgrade is one transaction: a failure leaves the store as it
was, and the next start tries again.

Named SQL runs against connection-local temporary views for its owner. Existing
`main.table`, `memory.table`, `memory.main.table` and computed dynamic named
references remain valid without editing saved SQL. A warm artifact metadata
cache does not retain dataset views between evaluations. Publication queries
retain their owner's scope even when that account is deactivated.

**Breaking SQL change:** user file readers and engine path discovery are refused
even for an owned file or an existing path. File-referencing PROJ definitions
(including computed CRS values, initialization files, grids and models) are
also refused. EPSG identifiers and inline definitions without files still work.
Saved SQL and publication tokens survive unchanged; an affected query or published layer fails until its owner
changes the SQL to refer to an uploaded dataset by name. Review saved queries
for file readers, file-relation shorthand and metadata definition/path access
before upgrading. See
[the SQL boundary](https://dezfil.io/docs/api/reference/query/#post-api-query) for the execution rules.

Unlabelled browser SQL drafts and history from older releases cannot be
attributed to an account and are discarded when the private workspace first
opens. Copy any draft you need before upgrading. Once labelled, same-account
reloads retain drafts; sign-out or an account change clears private browser
memory, including assistant recovery locators and prepared download state.
Saved layer and workflow SQL in the data directory is unaffected by this
browser cleanup.

## Finishing account deletion

Users lists pending and needs-retry deletions separately from accounts. Finish
deleting resumes the same record and is safe to retry after restart. Never remove
its journal or edit its identity rows manually. An active admin uses the same
status and continuation operations through the [API](../api/http-api.md) or [MCP](../api/mcp.md).
A long-lived outside reader, such as a replication sidecar, can keep deletion unfinished until it releases the database; release it, then use Finish deleting.

Check free space on both the data volume and SQLite's temporary filesystem. The
whole metadata-store rewrite pauses every response, including health. Across two
runs on one machine, the 1 GiB observations ranged from 3.4 to 13.2 seconds in the
container (nine trials) and 9 to 38 seconds on the host. The repeat run observed up
to 1.55 seconds at 64 MiB and 3.07 seconds at 256 MiB. These observations set no
bound and promise no maximum pause. A slow or nearly full disk and a host short of
memory make it longer. The [host guide](what-leaves-the-instance.md#leaving-and-deleting-accounts)
states space planning, cache purge and exact copy limits. A failed compaction stays
unfinished and can be retried.

## Retained account identity upgrade

Stop the instance and verify a whole-data-directory backup, including `secret.key`,
before starting this version. Rehearse on a separate scratch copy first. The account
constraint rebuild preserves every row, SQL home, index and trigger. It disables
foreign-key enforcement outside its transaction, checks the complete foreign-key
and database integrity before commit, and restores enforcement on success or failure.
A failed rebuild rolls back; opening again retries it.

Deleted identities reserve their SQL name permanently. Their profile fields are
absent; the original-account adoption marker still prevents setup from reopening.
The immediately preceding application
can read and write this migrated schema **only while no account is deleting or
deleted**. This is not recovery-command compatibility: local recovery requires this
version's command and its matching schema pin. Rollback restores the matched old
application and the complete stopped backup, never a down-migration of the live file.

## Full backup and restore

Stop every process using the directory before copying it. For a checkout managed
by a service, stop that service first. With absolute paths chosen for your host:

```sh
store=/srv/dezfil/data
backup=/srv/backups/dezfil-stopped
# Stop the instance before this copy. The destination must not already exist.
test ! -e "$backup"
cp -a "$store" "$backup"
```

Keep the application version and deployment configuration with the backup. Include
`secret.key` if generated; store the exact externally supplied `DEZFIL_SECRET_KEY`
securely if you use one. Preserve SQLite journal/WAL files and all artifacts,
account/session/token records, model catalogue, caches and thumbnails.

Restore with the instance stopped, keeping the displaced directory for inspection:

```sh
store=/srv/dezfil/data
backup=/srv/backups/dezfil-stopped
test ! -e "$store.before-restore"
mv "$store" "$store.before-restore"
cp -a "$backup" "$store"
# Start the matching application version with the matching encryption key.
```

For the named Docker volume of [Install](../start/install.md), use your installed image to copy the
stopped volume. Choose an empty backup directory and keep its contents private:

```sh
docker stop dezfil
mkdir -m 700 "$PWD/dezfil-backup"
docker run --rm --user root --entrypoint sh \
  -v dezfil-data:/data:ro -v "$PWD/dezfil-backup:/backup" dezfil \
  -c 'cp -a /data/. /backup/'
```

Restore into a new volume so the current copy remains available:

```sh
docker volume create dezfil-restored
docker run --rm --user root --entrypoint sh \
  -v dezfil-restored:/data -v "$PWD/dezfil-backup:/backup:ro" dezfil \
  -c 'cp -a /backup/. /data/ && chown -R node:node /data'
docker run -d --name dezfil-restored -p 127.0.0.1:3210:3000 \
  -v dezfil-restored:/data dezfil
```

Use the backed-up image version and supply the original external encryption key,
if any, through your deployment's secret mechanism. Check sign-in, datasets, maps,
workflows and published links on the isolated restore before routing traffic to it.
Token secrets cannot be read back. Restored credentials keep their backed-up
validity and expiry; revocations made after the backup are absent. Review access
before exposing the restore. No restoration can recover later writes.

To rehearse an upgrade, start the new image against a separate copy of this stopped
backup on an isolated port. Check readiness, sign-in and representative saved work,
then stop the rehearsal. Only then start the new image on the original directory.
An upgrade from a release without accounts still needs first-admin setup under
restricted access. Existing last changers and history authors start unknown; new
changes record their own actors. Legacy runs keep their stored or adopted initiator. See
[self-hosting](what-leaves-the-instance.md#upgrading) for the attribution limits.

## Admin account recovery

Run these in a terminal, using the application version matching the existing
store. The origin is the address the recipient will open, with no path, query,
credentials or fragment. `--email` matches a normalized exact email; omit it only
when there is exactly one active admin.

Checkout:

```sh
npm run admin:recover -- --data-dir /srv/dezfil/data \
  --origin https://maps.example.com --email admin@example.com
```

Running container:

```sh
docker exec -it dezfil node scripts/admin-recover.mjs \
  --data-dir /data --origin https://maps.example.com --email admin@example.com
```

One-off container against the stopped volume, without starting the server:

```sh
docker run --rm -it -v dezfil-data:/data dezfil \
  node scripts/admin-recover.mjs --data-dir /data \
  --origin https://maps.example.com --email admin@example.com
```

The last two commands allocate a TTY because the link is terminal-only. Do not
pipe it to a log. The command selects an active admin in a setup-complete compatible
store; it never initializes, upgrades, promotes or reactivates an account. A busy
store is retried for at most five seconds and then refused without changes.
Successful issuance revokes that account's password, earlier links, sessions and
API/MCP tokens and prints one fragment link with account and expiry. Open it
within fifteen minutes and choose a password. Other accounts are unaffected.
This is not compromise cleanup; see the [limits](what-leaves-the-instance.md#recovering-an-admin-account).

## Headless clients

Create an API / MCP token in Settings, copy the secret once and supply it as
`DEZFIL_API_TOKEN` through your client's secret storage. It grants the same current
permissions as that account, including project roles, with no admin content bypass.
The following shell example requires `curl` and `jq`. It creates a private map,
reads it and chains two accepted writes before printing the resulting revision:

```sh
set -eu
base=https://maps.example.com
: "${DEZFIL_API_TOKEN:?Supply an account token}"
request() { curl --fail-with-body -sS -H "Authorization: Bearer $DEZFIL_API_TOKEN" "$@"; }
created=$(request -X POST "$base/api/maps" -H 'Content-Type: application/json' -d '{"name":"Field notes"}')
id=$(printf '%s' "$created" | jq -er '.id')
current=$(request "$base/api/maps/$id")
revision=$(printf '%s' "$current" | jq -er '.editRevision')
changed=$(request -X PATCH "$base/api/maps/$id" -H 'Content-Type: application/json' \
  -H "X-Edit-Revision: $revision" -d '{"name":"Survey map"}')
revision=$(printf '%s' "$changed" | jq -er '.editRevision')
changed=$(request -X PATCH "$base/api/maps/$id" -H 'Content-Type: application/json' \
  -H "X-Edit-Revision: $revision" -d '{"basemap":"light"}')
printf '%s' "$changed" | jq -er '.editRevision'
```

A 409 `stale_revision` stops the example. Inspect a fresh read and deliberately
compose a new edit; do not attach its token to the refused payload and replay it.
A 400 `invalid_request` for a missing revision means the client must implement the
read/write contract. Child writes use the parent's revision. See the
[API](../api/http-api.md#edit-with-revisions) and [MCP](../api/mcp.md#edit-safely)
guides for compound filing, run starts, exceptions and executable examples.

## Without the image renderer

Without the image renderer, the headless Chromium `DEZFIL_CHROMIUM_PATH`
names, map listings report `pictureState: unavailable`,
refresh answers `outcome: unavailable`, and existing pictures stay served.
The admin System read, `GET /api/instance/settings`, reports this as
`parts.image_renderer.available`; `found` separately reports file presence.
The System tab's Image renderer row reads Not found without the program and
Could not start after a launch refusal, and every page of map cards tells
administrators so in one line at its foot. Install or restore the configured
executable; the hourly look discovers recovery without an edit. A launch refusal
also holds picture work unavailable until that look, even if the file exists.
Map pictures are made on the server even when nobody opens their builder.

## Troubleshooting

**The image export fails while health stays green.** The headless browser
is missing or unreachable at `DEZFIL_CHROMIUM_PATH`. That split is
deliberate: removing the browser leaves readiness alone.

**Stored connection credentials stop decrypting.** They are encrypted with
`DEZFIL_SECRET_KEY`, or the `secret.key` generated into the data directory
on first boot. Changing that variable later, or losing `secret.key` while
keeping `metadata.sqlite`, makes them unreadable and those connections must
be entered again. To pin the key without loss, set `DEZFIL_SECRET_KEY` to
the hex string already in `secret.key`.

**The model catalogue silently falls back.** An instance
`assistant-models.json` is rejected whole on any invalid entry and the
shipped catalogue applies instead; `GET /api/assistant` says which
([Offer other models](assistant.md#offer-other-models)).
