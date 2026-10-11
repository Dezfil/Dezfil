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
and privately delivers a single-use invitation or reset link, valid for the
instance's link lifetime, seven days unless an admin changes it on the
**Security** tab of Settings. The recipient chooses a password of at least the
instance's shortest password, eight characters unless an admin raises it there;
very common passwords are refused. The first account always takes eight, and a
raised minimum applies to passwords set after it: older ones keep signing in. Issuing a replacement link invalidates the previous links,
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

## Settings

The Settings column has two groups. Under **You**, every account has **Account**
(name, email and password), **Tokens** and **Appearance**. Under **Instance**,
admins have **General**, **Maps**, **Workflows & SQL**, **Publishing**,
**Data & services**, **Limits**, **Security** and **System**, with Users linked at
the column's foot; members see General alone, read-only.

- **Appearance** is the person's own look: Color (Kelp, Harbor, Heather or
  Slate), Contrast (Standard or More contrast), Background (Atlantic chart,
  Plain, Graticule or Hex lattice), Typeface (Inter, or System for the
  computer's own), Corners (Rounded or Soft) and Side menu (Opens on hover,
  Always open or Icons only). A pick changes the page at once and is kept with
  the account, so every other browser that account uses shows it from its next
  page load, with no flash of the default first. The look is never shared and
  never reaches a published page or an image of a map: those keep Dezfil's
  default look. There is no instance-wide look, and the light and dark button in
  the header stays a choice of each browser.
- **General** holds the instance name, shown beside the wordmark and in browser
  titles, and the sign-in page: a message under its heading, who to ask about a
  lost password, and the page people open after signing in (Home, Projects, Maps,
  Workflows, Data or SQL). Anyone who opens the sign-in page can read the message,
  so keep anything private out of it.
- **Maps**, **Workflows & SQL** and **Publishing** hold what new things start
  with. Maps: a new map's basemap, starting view (a click on the small world
  map sets its latitude and longitude) and legend corner, and a new layer's
  color cycle, opacity for points, lines and areas, line width and point radius.
  Workflows & SQL: whether a workflow canvas opens full screen or framed, its
  minimap and results band, and the SQL console's text size and line wrap.
  Publishing: the starting width and shape of a fresh image export card. They
  apply to new things only: maps and layers that already exist, their published
  views and images, and a screen already open keep what they have. Someone's own
  minimap or results band choice still wins in their browser. Members meet the
  defaults as the starting state of what they make;
  [the configuration guide](configuration.md#instance-defaults) lists every value.
- **Publishing** also holds **Public links**: who may publish (Everyone, Admins
  only or No one) and embedding on other sites (Any site, Listed sites, one site
  per line, or Off). Maps already published stay public until unpublished; a
  published page follows the embedding choice from its next load, so embed code
  on a site no longer allowed stops showing the map.
- **Data & services** holds the address finder, travel time, OpenStreetMap,
  Overture, cloud storage, the template catalogue, the private hosts the server
  may reach, and who may add database connections and import from links. A service's address is
  pasted whole and kept on Save, then shows only as its scheme and host with
  Set (OpenStreetMap's public server and Amazon S3 show Default); a new key
  means pasting the whole address again, and Remove asks first. An address the
  egress rules would refuse is refused at save, and the address finder or
  travel time without an address shows Not set up. A card's gap between
  requests, answer time limit and how long answers are kept change as the
  limits do, and its Reset leaves the address alone. Test sends the service one
  request and says how it answered, Clear empties a cache, and Check now lists
  Overture's releases again. The Templates card turns the catalogue on or off,
  keeps its address as a service's (a folder its variable names shows as a
  folder, never its path), tests it while it is in use, and shows how much the
  downloaded templates take, with Remove all, which asks first and leaves the
  shipped templates and every copy. Reading cloud storage with the server's
  credentials and the hosts the server may reach show locked, naming their
  variables.
- **Limits** changes the editable limits while the instance runs; new work uses a
  changed value at once. A limit its environment variable sets is shown locked,
  naming the variable, and changes only through the environment and a restart.
- **Security** holds sign-in (how long people stay signed in, how long invite
  and reset links last, failed sign-ins per account and per address before a
  pause, and the shortest password) and API tokens (who may create them and
  when new ones expire). No save signs anyone out or changes a link, token or
  password that already exists; each applies from the next session use, link,
  sign-in attempt, password or token. Who may add database connections and who
  may import from links are on Data & services;
  [the configuration guide](configuration.md#security-and-rules) lists every
  value.
- **System** shows the version and how long the server has run, whether the data
  folder is writable, whether the assistant is on, and every setting a variable
  decides, with the value in effect and where it came from. A credential shows
  only whether it is set, and an address only its scheme and host.

Choices and numbers are kept as they change; typed text waits for Save. A card
offers Reset to defaults while it differs from its defaults, then Undo for a few
seconds. Appearance also offers **Reset to Dezfil's default** at the right of
its heading while any pick differs, which returns every pick at once with the
same Undo. Leaving a tab with unsaved typed text asks first.

## Leaving and deleting accounts

A Viewer or Editor can leave a project, including a frozen one. Leaving ends only
that person's membership. Their owned work stays filed and shared; they can
withdraw it separately. Project owners must transfer or dissolve the project.

To keep a person's work for the team, leave the account deactivated. Shared reads,
exports, downloads, SQL, map/workflow duplication, permitted workflow runs and
published links remain available. Frozen work cannot be edited in place or gain
members. Before deactivation the owner can transfer projects, maps and workflows
to existing members; datasets and connections cannot transfer.

Another active admin can permanently delete an account after separate deactivation,
including a deactivated admin. An invitation never redeemed can be removed directly.
Users shows totals and the number of other people losing reach, without revealing
private resource names. Confirm the current preview and type the exact email for
an ever-active account. Deletion erases everything that account owns wherever filed,
dissolves its projects, unfiles other members' surviving work, and breaks its
published links and embeds. Surviving maps and workflows report missing inputs.
No handover or undelete is provided.

Pending and needs-retry mean unfinished. The account and its work remain
inaccessible, its email stays reserved, and Users offers **Finish deleting**, also
after restart. Use the same deletion identifier through the API or MCP. Completion
frees the email and removes the temporary deletion record; a subsequent status
read returns not found. Deleting the original profile never reopens setup or
adoption. Remaining admins can use this version's packaged local recovery command.
A long-lived outside reader, such as a replication sidecar, can keep deletion unfinished until it releases the database; release it, then use Finish deleting.

Finishing a deletion rewrites the whole metadata store, and the app answers nothing
while that compaction runs, including health requests. Across two runs on one
machine, the 1 GiB observations ranged from 3.4 to 13.2 seconds in the container
(nine trials) and 9 to 38 seconds on the host. The repeat run observed up to
1.55 seconds at 64 MiB and 3.07 seconds at 256 MiB. These observations set no bound
and promise no maximum pause. A slow or nearly full disk and a host short of memory
make it longer. Plan capacity and maintenance around that pause.
SQLite needs free working space for a temporary database and a write-ahead log:
allow up to twice the metadata database size in additional free space when both
use one filesystem. With separate filesystems, allow roughly one database size
on the data volume for the log and one on SQLite's temporary filesystem for the
copy, with headroom for other writes. A large data volume does not compensate for
a full or memory-limited temporary filesystem. See SQLite's
[VACUUM space explanation](https://www.sqlite.org/lang_vacuum.html).
Compaction that cannot finish leaves deletion unfinished and safe to retry after
space is restored or the reader is released.

Except for never-redeemed invitations, deletion purges the entire geocode,
isochrone and Overpass answer caches. Subsequent requests contact providers again,
with their usual latency and cost. Instance settings, keys and palettes remain.

An ever-active account keeps an opaque deleted identity and its identifying SQL
name, permanently reserved, plus the original-adoption marker where applicable.
Its name, email, credentials and profile disappear. Surviving SQL homes never move,
so reusing the freed email cannot capture old dataset references. Historical actors
show **Deleted account**, distinct from **Unknown**, without a name or SQL-name
label; times and authorship stay fixed. This is not anonymization or a promise to
erase physical disk remanence.

Deletion has these copy and attribution limits:

- Other people's derived datasets remain theirs permanently. Their SQL, lineage,
  run records and stored run sentences can retain dataset names, artifact identities
  and personal text. Runs of workflows deleted before their owner's account have
  no remaining workflow owner and stay, showing **Deleted account** as their starter.
- Already issued private copies keep their existing lifetime. Completion waits for
  prepared files to settle or expire and for observed cleanup. Recorded input
  evidence removes affected card images, tiles, retained renders and prepared files,
  even when another person owns them. Existing unattributed card images belonging to
  other people remain because their source datasets cannot be identified.
- A retired dataset generation that failed to unlink before file ownership was
  tracked is removed by the startup sweep, not by deletion's completion.
- Copies outside the instance are not reached: backups, snapshots, exports,
  downloaded files, host-collected logs, provider-held data and a database a
  connection wrote to. Browser-local SQL and conversations also remain. Restoring
  a backup can revive erased data and credentials; review them before reopening.

Before upgrading or rolling back, follow the [retained-identity upgrade and full
backup instructions](runbook.md#retained-account-identity-upgrade). Keep a stopped,
complete backup and the matching application and key; do not down-migrate a live
store containing deleting or deleted accounts.

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

## Server-side render destinations

Image exports and map checks launch a fresh Chromium browser. Page requests
are admitted against the instance's egress policy, and external TCP connections
use an ephemeral SOCKS5 relay in the app process. The relay resolves each new
connection, requires every returned address to be admitted, and dials only those
literal addresses. A changed DNS answer cannot move an admitted request onto a
denied private destination. An unreachable admitted address can fall back to
another admitted address from the same lookup. Private literals, mixed answer
sets, redirects and style dependencies receive the same checks.

Only the app's exact scheme, literal host and port bypass the relay. App render
credentials stay on that exact origin. `DEZFIL_EGRESS_ALLOWLIST` retains its
existing hostname, IP and CIDR exceptions: an allowlisted hostname remains
trusted whatever it resolves to. Ordinary public destinations remain available.
A policy denial returns the shipped `render_failed` refusal without a PNG;
ordinary DNS or transport failure retains the data-only dead-basemap state.
Relay startup failure returns the generic render failure and never launches a
direct browser as a fallback. Queue-inclusive budgets and cancellation still
apply, and relay sockets/listeners are owned by the render's cleanup.

The listener binds only to loopback, once per render, and uses no authentication.
Another local process can use it under that same destination policy; it promises
neither local-client authentication nor exclusivity. HTTPS stays between Chromium
and the destination: the relay tunnels bytes without terminating TLS or changing
certificate validation. Trusted-HTTPS compatibility needs its own observed
browser proof; the HTTP destination gate does not supply that evidence.

This boundary concerns server-side style-driven rendering. It is not a statement
about a viewer's browser, service workers, WebSocket, browser-owned background
requests, or UDP/QUIC suppression. The launch flags configure suppression, but
those supplementary claims are reported individually. The
[destination probes](render-egress-probes.md) and
[TLS/timing recipes](render-comparison-probes.md) separate connection assertions,
scripted browser stimuli and unobserved claims. The latter probes stay outside
the image job; no additional production service or setting is required.

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
  Submitted place searches carry client cancellation through the shared
  geocoder queue and exchange. Superseding a search or leaving the builder
  aborts it; an independent request does not cancel another caller's work.
  Advisory custom-basemap checks similarly abort on replacement, URL edit,
  Cancel or panel departure. See the [provider cancellation
  recipe](provider-cancellation.md) for the route and browser probes, timeouts
  and retained save behavior.
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

SQL console/SQL previews, dataset inspection, geometry-choice preview and the
PostGIS five-row preview have fixed result limits: **33,554,432 bytes (32 MiB)**
for the complete uncompressed UTF-8 JSON answer and **2,097,152 bytes (2 MiB)**
for one non-geometry column value. Equality is admitted. Quotes, escaping,
nested values, schema, repeated keys and metadata count after existing display
conversions and excerpts. Native geometry, identified by type or registered
provenance before conversion, counts only toward the result ceiling; coordinate
text and JSON remain non-geometry. Exceeding either bound refuses the whole
answer with HTTP 422 `query_result_too_large`, without partial data or details:

> The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.

These ceilings have no setting. Row and engine-memory limits still apply;
a result below both byte ceilings can fail the engine-memory limit during
query execution or result projection, including geometry decoding. Layer
renders, dataset map features, slider and Overture previews,
published views, statistics, classification, widgets and value search retain
their existing limits. SQL, table and layer file exports still stream complete
results above both ceilings. A refused dataset inspection prevents its detail and docked set-geometry
panel from opening. It also blocks tool column pickers, SQL schema inventory
and completion, workflow dataset reads and facts, and automatic layer addition
after a tool run. The tool run can report failure even though the dataset has
already been written. Existing layer rendering, dataset map features, complete
API file exports and owner deletion from Data use separate reads and remain
available. This bounds serialized data on the covered reads,
not native chunks, JavaScript object overhead, heap or RSS.


The query engine runs server side, so the work happens on your machine rather than in
the viewer's browser. Data beyond what a browser could hold is the point of the
design, and the limit is your disk and memory rather than a tab.

The settings table has the bounds worth knowing: how large an upload may be, how many
rows a query may return, when a layer becomes tiles instead of features, and how
often the instance will talk to an external service. Admins change the editable ones
on the Limits and Data & services tabs of Settings without a restart. The defaults are chosen to be
safe on a small machine. Raise them deliberately, not because a limit annoyed you
once.

Authentication entry, Account, Users and all three anonymous published POSTs
admit at most 65,536 wire bytes of JSON. Other JSON, including MCP and workflows,
admits 16,777,216; assistant messages keep 131,072 and their own refusal code.
These limits include UTF-8, escaping and whitespace regardless of Content-Type.
Optional bodies obey the same bound. Excess returns 413 before parsing, never
a default or a write. Workflow and assistant refusal wording stays unchanged;
[the API guide](api.md#request-bounds) gives the exact envelopes.
MCP base64 uploads must be below 12 MiB after envelope and metadata overhead.
Published render selections remain at 65,536 bytes even within their semantic
filter counts; the viewer's twelve selections of fifty long values fit.

The canonical spellings of the anonymous published widget-values, render and
extent POST paths bypass the framework proxy. Encoded-slash spellings can still
match the proxy and incur its body copy. Their handlers admit at most 65,536 bytes and refuse excess
before parsing; empty bodies retain their existing defaults. All dispatchable
methods on excluded paths retain their method-specific request gate. `TRACE`,
which no handler can receive, is answered with an empty 400 on every path before
its body is read.

Multipart uploads at the canonical `/api/tables` path bypass the framework proxy
and stream to scratch storage under the configured file and archive limits.
Workflow JSON keeps its 16 MiB limit.
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
10,000 source entries are retained. Traffic sweeps expired windows at most once
per second; between sweeps, a new source at capacity evicts the least recently
used entry. The bound holds either way. Eviction grants a fresh window.
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

Password derivation admission is shared across the server process: two active,
six ordinary plus two reserved protected waiters, and a five-second maximum
wait. FIFO applies within each class. Validated links and signed-in password
checks are protected, with priority for the next slot and at most one active
protected derivation. Ordinary sign-ins can use both slots. Full classes and
deadlines answer private 503 `authentication_busy` with one-second retry advice,
without adding login failures or a lasting lockout. Running work retains its
slot until settlement. These fixed bounds introduce no configuration knob;
actual derivation time depends on the host.

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
successful recovery replaces it. Ordinary admin-issued resets keep the
instance's link lifetime, seven days by default.

Recovery restores entry, not trust after hostile setup or a compromised machine.
It does not remove an intruder's other accounts, undo content changes or revoke
other accounts' credentials. Isolate such an instance and restore a trusted backup
or rebuild after assessing what changed. Filesystem control already grants control
of the data; there is no network recovery endpoint or ownership bypass.
