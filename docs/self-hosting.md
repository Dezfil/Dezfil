# Self-hosting

This page is for the person who runs the instance. It covers what to decide before
you put data in it, what the instance keeps, and what it sends out.

The `README` has the run commands and the full table of settings. Start there, then
read this.

## Who can reach it is the whole access model

This release has no accounts and no login. Anyone who can reach the instance can edit
everything in it, and anyone holding a published link can view what that link points
at. That is a property of the release, not a defect, and everything below follows
from it.

Run it where you control who can connect: a private network, a VPN, or behind a
reverse proxy that does the authenticating. If you put it on a public address, treat
every dataset in it as public.

A published link is a capability. It carries a token, it is not guessable, and it
grants read access to one published map until you unpublish it. Anyone the link
reaches can pass it on.

## The data directory is the product

Everything the instance keeps lives in one directory, the durable data directory,
mounted as a volume in the container. Tables, the map and layer metadata, published
links, the encryption key, cached tiles and thumbnails are all inside it. Nothing the
instance needs lives outside it.

That makes three operations simple:

- **Back up** by stopping the container and copying the directory. A copy taken while
  the instance is running may catch a write in progress.
- **Move to another machine** by copying the directory and mounting it in a new
  container.
- **Upgrade** by starting a newer image against the same directory.

Running without a volume works and is useful for a look around, but the state then
lives and dies with that container.

## The encryption key

Stored credentials, such as the password for a database connection, are encrypted at
rest. The key comes from the setting if you provide one; otherwise the instance
generates one on first boot and writes it into the data directory.

Set it explicitly if your backups and your data directory can ever become separated,
because data encrypted under a lost key cannot be recovered. Keep it out of your
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

## Upgrading

Stop the container, start the new image against the same data directory. The metadata
carries its own versioning and migrates forward on boot. Take the backup first: a
migration that runs is easier to undo from a copy than from a snapshot you did not
make.

Read the changelog before a major version.
