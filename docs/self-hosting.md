# Self-hosting

This page is for the person who runs the instance. It covers what to decide before
you put data in it, what the instance keeps, and what it sends out.

The `README` has the run commands and the full table of settings. Start there, then
read this.

## Accounts and access

Keep a fresh instance reachable only by you until first-admin setup is complete.
The first person to finish setup becomes the admin. Bind the container port to
loopback or restrict access at your proxy before opening the setup page. Once an
account exists there is no open signup.

Admins invite people from Users. Dezfil sends no outbound mail: the admin copies
and privately delivers a single-use invitation or reset link, valid for seven days.
The recipient chooses a password of at least eight characters; very common
passwords are refused. Issuing a replacement link invalidates the previous links,
password and browser sessions. Ordinary resets leave API tokens valid; their owner
can revoke those separately in Settings. Deactivated accounts cannot redeem a link.

Each account owns its maps, datasets, workflows, projects and connections.
Projects are the sharing boundary. A project owner gives another account a
**Viewer** or **Editor** role for everything filed there. Viewers read; Editors
also edit maps and workflows and run workflows. Deleting, publishing, sharing and
transferring stay with the resource owner. Datasets change only by their owner;
connections are never shared. Runs create outputs owned by their runner.

Admin authority manages accounts and instance preferences, without access to
another person's private content. Owners can transfer a map or workflow filed in
a shared project to someone it is shared with, and transfer a project to one of
its members. Datasets and connections cannot transfer. Deactivation ends sessions
and prevents token use, but keeps ownership, content and published links. An admin
can revoke a deactivated owner's known published token without reading the map.
Reactivation restores access to retained work; it does not restore ended sessions.
Another admin must remove your admin flag or deactivate you, and at least one
active admin must remain.

For scripts and agents, create an API / MCP token in Settings. Its secret is shown
once, and its authority follows the account's current permissions. Keep the secret
with the client; revocation stops REST and MCP use together.

A published link is a capability. It carries a token, it is not guessable, and it
grants read access to one published map until you unpublish it. Anyone the link
reaches can pass it on.

## The data directory is the product

Everything the instance keeps lives in one directory, the durable data directory,
mounted as a volume in the container. Tables, the map and layer metadata, published
links, accounts, password hashes, sessions, API token records, workflows and run
records, generated encryption keys, cached tiles and thumbnails are all inside it.
An externally supplied `DEZFIL_SECRET_KEY` must be preserved separately.

That makes three operations simple:

- **Back up** by stopping the container and copying the directory. A copy taken while
  the instance is running may catch a write in progress.
- **Move to another machine** by copying the directory and mounting it in a new
  container.
- **Upgrade** by starting a newer image against the same directory.

Running without a volume works and is useful for a look around, but the state then
lives and dies with that container.

A full stopped backup includes `metadata.sqlite` and any SQLite journal/WAL files,
all artifact directories, thumbnails, caches and the optional model catalogue.
Do not back up only the GeoParquet files or only SQLite. Restore the whole copy
into an empty directory with the matching application version and encryption key.
Restore file ownership so the container's `node` user can read and write it.

Passwords and tokens are not recoverable as plaintext. Restored account, session,
link and token records retain their backed-up validity and expiry: a credential
revoked after the backup can become valid again after restoration. Review and
revoke restored credentials as needed before reopening access. Work accepted
after the backup is not in the restore. Test the restore on an isolated port and
copy, never with two servers writing the same directory. The
[runbook](runbook.md#full-backup-and-restore) gives checkout and volume commands.

## The encryption key

Stored credentials, such as the password for a database connection, are encrypted at
rest. The key comes from the setting if you provide one; otherwise the instance
generates one on first boot and writes it into the data directory.

If you set `DEZFIL_SECRET_KEY` externally, back up that exact value securely
alongside the deployment configuration. Otherwise include `secret.key` from the
data directory. Data encrypted under a lost or wrong key cannot be recovered. Keep it out of your
shell history and out of version control, the way you would any other secret.

## What leaves the instance

Four flows send data off the machine. Three are off until you configure them. One is
on by default.

| Recipient | What is sent | When |
|---|---|---|
| Basemap tile host | tile requests, carrying the viewer's address | **on by default**, in every browser that opens a map |
| The configured AI provider | the conversation, the instance grounding, tool results, and map images | only once a key is configured |
| The configured geocoder | place-search queries, and for the batch operation the address column | only once its URL is set |
| The configured travel-time service | origin coordinates and travel parameters | only once its URL is set |

Notes worth having before you switch any of them on:

- **The basemap** is the one to know about, because it needs no configuration to be
  active. The default style is fetched from a public tile host, so every viewer's
  browser contacts a third party. Point the basemap setting at your own tile server to
  stop that, and set the matching attribution so the credit names whoever is actually
  serving the tiles.
- **Satellite imagery ships with nothing.** There is no imagery provider and no key
  bundled, so no imagery basemap is offered until you configure a tile template, your
  own key or token, and the attribution string your provider requires. That credit is
  then shown on every map that uses the imagery and travels with anything published
  from one. Check your provider's terms cover the way your instance will be used;
  several of the well-known imagery services require a subscription for anything
  beyond evaluation, and some free ones are non-commercial only.
- **The geocoder** receives whatever the user typed, and for the batch operation the
  whole address column of a table. A public geocoding service is a third party
  receiving your addresses, and the public instance of the common one asks that you
  not send personal or confidential data through it. Run your own if the addresses
  are not yours to share.
- **The AI assistant** is off until a provider key is set. Once it is on, the
  conversation, the grounding about your instance, the results of the tools it calls
  and images of your maps are sent to that provider. Which model, and whose service,
  is your choice through the settings.

There is no telemetry. The instance reports nothing about itself to anyone.

## What you are responsible for

You run the instance, so you are the one who decides what data goes into it, who can
reach it, and which third parties it talks to. Publishing this software does not make
its authors responsible for your deployment. If the data is regulated, the obligations
attach to your installation, not to the project.

## Resources and limits

The query engine runs server side, so the work happens on your machine rather than in
the viewer's browser. Data beyond what a browser could hold is the point of the
design, and the limit is your disk and memory rather than a tab.

The settings table has the bounds worth knowing: how large an upload may be, how many
rows a query may return, when a layer becomes tiles instead of features, and how
often the instance will talk to an external service. The defaults are chosen to be
safe on a small machine. Raise them deliberately, not because a limit annoyed you
once.

The anonymous published widget-values, render and extent POST paths bypass the
framework proxy too. Their handlers admit at most 65,536 bytes and refuse excess
before parsing; empty bodies retain their existing defaults. All dispatchable
methods on excluded paths retain their method-specific request gate. `TRACE`,
which no handler can receive, is answered with an empty 400 on every path before
its body is read.

Multipart uploads bypass the framework proxy and stream to scratch storage under
the configured file and archive limits. Workflow JSON keeps its 16 MiB limit.
The framework proxy copy limit is 17 MiB (previously 10 MiB), so complete workflow
requests, including their over-limit refusal boundary, reach their readers.
On paths still matched by the proxy, the framework drains and copies the body
before the request gate runs, including for anonymous callers. The 17 MiB copy
is bounded storage, not early wire admission. Authentication entry POSTs remain
on that path. Configure a fronting reverse proxy's own request-size limit to
bound this pre-gate copy further, allowing the upload size you intend to serve
on `/api/tables`.

When one of these four paths refuses a request part-way through its body, the
answer is sent at once. The instance then receives and discards the rest of that
request, storing nothing, so the connection stays usable; the server's request
and keep-alive timeouts bound it. A fronting proxy's request-size limit stops
such bytes before they reach the instance.


Anonymous published API reads use verified ingress sources. View, widget-values,
render and extent share 60 requests per ten seconds across tokens; tiles have
600 in their separate bucket, with the existing configuration overrides.
Unknown tokens are charged before resolution. Across both buckets, at most
10,000 source entries are retained: traffic removes expired windows, then
capacity evicts the least recently used entry. Eviction grants a fresh window.
Window expiry permits retry; a refusal remains 429 `rate_limited`, “Too many
requests. Please slow down.” No new retry-header guarantee applies.

Direct socket sources have independent budgets; equivalent IPv4 and mapped
IPv4 addresses share one. A trusted proxy chain uses the nearest untrusted hop.
Behind an untrusted proxy, readers share its socket budget by design; forwarded
headers cannot separate it. Missing or forged provenance answers private,
no-store 503 `ingress_unavailable`, “The instance cannot serve published maps
yet.”, before reading a body or resolving a token. Malformed wire provenance
still answers 400. The viewer page is outside these API budgets; IPv6 address
rotation is not bounded by this policy.

## Upgrading

Stop the container, start the new image against the same data directory. The metadata
carries its own versioning and migrates forward on boot. Take the backup first: a
migration that runs is easier to undo from a copy than from a snapshot you did not
make.

Read the changelog before a major version.

An instance upgraded from a release without accounts shows setup once. Complete
it promptly: whoever reaches setup first becomes the admin over the existing data.

An ownership upgrade adopts old work into the recorded original account, even if
that account is no longer an admin. With no accounts yet, first-admin setup adopts
it atomically. It preserves identities, SQL homes, memberships, public links and
artifacts. It does not make existing private projects shared.

Edit-revision storage is additive. Existing maps and workflows receive durable
revisions while their pre-existing last changer and history authors remain
**Unknown**. Ownership adoption is not evidence of authorship. Existing workflow
runs retain their stored initiator; older run records adopted into the original
account show that adopted initiator, not a newly inferred historical author.
The next accepted covered change records its real actor. Saved camera motion,
thumbnail capture and refused saves do not assign an author.

Clients that write maps or workflows must now read an edit revision and carry it
on each covered write. Formerly bodyless covered successes return JSON with the
new revision. Update headless clients with the server; see the
[API guide](api.md#editing-with-revisions). For rollback use the complete stopped
backup and its matching build. The revision-only schema additions support the
immediately preceding compatible writers, but that is not a general promise that
older releases understand ownership or sharing storage.

## Recovering an admin account

With filesystem access, use `npm run admin:recover` in a checkout or the packaged
`scripts/admin-recover.mjs` in the container. The
[runbook](runbook.md#admin-account-recovery) provides all three invocations.
The command requires an existing, compatible, setup-complete data directory and
an explicit reachable HTTP/HTTPS origin. It never creates or migrates a store.
It selects the sole active admin, or an exact email supplied with `--email` when
several exist. It cannot create an admin or reactivate an account.

Recovery works while the server is running or stopped. It waits at most five
seconds for a busy store; refusal prints no link and changes no credentials.
After successful issuance the selected account's password, earlier links, browser
sessions and API/MCP tokens are invalidated atomically. Other accounts and all
content, ownership and admin flags stay as they were.

The single-use link lasts fifteen minutes. Its secret is in the URL fragment,
shown only in the invoking terminal with the selected email and expiry. Use a TTY
and do not redirect the output into logs. Open the link at the supplied origin
and choose a new password. Restarting does not extend its expiry, and another
successful recovery replaces it. Ordinary admin-issued resets keep their
seven-day lifetime.

Recovery restores entry, not trust after hostile setup or a compromised machine.
It does not remove an intruder's other accounts, undo content changes or revoke
other accounts' credentials. Isolate such an instance and restore a trusted backup
or rebuild after assessing what changed. Filesystem control already grants control
of the data; there is no network recovery endpoint or ownership bypass.
