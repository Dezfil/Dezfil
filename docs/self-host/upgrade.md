---
title: "Upgrade"
summary: "Move your instance to a new version of Dezfil, keep its data, and go back to the old version if you need to."
read_when:
  - "a new version of Dezfil is out and you want to run it"
  - "you want to know what a new version does to your data when it starts"
  - "you want to go back to the version you ran before an upgrade"
  - "Dezfil does not start after an upgrade"
  - "after an upgrade, Settings cannot read a saved address"
audience:
  - operator
checked: none
order: 6
---

An upgrade downloads the new version while the old one runs, backs up the data, then replaces the container. The data stays in the `dezfil-data` volume, and the new version updates it when it starts.

The commands use the names from [Install](../start/install.md) and [Docker Compose](docker-compose.md): a container called `dezfil`, the image `ghcr.io/dezfil/dezfil` and a volume called `dezfil-data`. With Docker Compose, run them in the folder that holds `compose.yaml`.

## 1. Note the version you run

```sh title="Terminal"
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' dezfil
```

```text title="Output"
0.1.0
```

Write it down: it is the version you go back to, and the one to note with the backup of step 4.

## 2. Read what changed

The [releases](https://github.com/Dezfil/Dezfil/releases) list each version with its changes, and the [changelog](../../CHANGELOG.md) holds them all. Read the versions after yours.

Read the entries that begin with "Breaking" or "Compatibility". They say what you or your API clients must change, and what the new version changes in your data.

## 3. Download the new version

Dezfil keeps running while the new version downloads.

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker pull ghcr.io/dezfil/dezfil
```

To move to a version other than the latest, pull its tag, as in `ghcr.io/dezfil/dezfil:<VERSION>`, and use that name in step 5.

:::

:::tab[Docker Compose]

If `image:` in `compose.yaml` names a version, as in `ghcr.io/dezfil/dezfil:<VERSION>`, change it to the new one first. Then:

```sh title="Terminal"
docker compose pull
```

:::

::::

The running container keeps its own image until step 5 replaces it.

## 4. Back up

Check first that the container keeps its data in the `dezfil-data` volume:

```sh title="Terminal"
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' dezfil
```

```text title="Output"
dezfil-data
```

It prints the name of the volume mounted at `/data`, the data folder, and leaves out the container's other mounts.

- If it prints another name, your data is in that volume: write its name in place of `dezfil-data` wherever this page and [Back up and restore](backup-and-restore.md) name it.
- If it prints an empty line, `/data` is a folder of this machine, not a volume, and the backup below would not copy your data. Stop Dezfil, copy that folder instead, and mount it in place of `dezfil-data` in step 5.

Let running tools and workflows finish. Then back up the volume as [Back up](backup-and-restore.md#back-up) shows: it stops Dezfil, copies the volume to `$HOME/dezfil-backup`, prints `Copied` and starts the old version again. The version to note with this backup is the one step 1 printed.

If you set `DEZFIL_SECRET_KEY`, in `.env` or with `-e`, keep its value too, apart from the backup, as [The encryption key](backup-and-restore.md#the-encryption-key) says.

> [!NOTE]
> A tool run cut off by a stop ends as failed, a workflow run as **Interrupted**, and neither runs again by itself.

## 5. Start the new version

> [!WARNING]
> If the version you upgrade from had no accounts, Dezfil opens on **Create the first account**. The first person to finish it becomes the admin and owns every existing map, dataset, workflow, connection and project. Keep the instance private until you have, as in [First run](../start/install.md#first-run).

::::tabs

:::tab[Docker]

A new container gets none of the old one's options. List its variables before you remove it, as [Set a variable](configuration.md#set-a-variable) shows.

```sh title="Terminal"
docker rm -f dezfil
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data ghcr.io/dezfil/dezfil
```

- `docker rm -f dezfil` stops and removes the old container. The volume stays.
- `docker run` starts the new version on the same volume. Add the `-e` variables your old container had, and give `-p` its port if you changed it.

:::

:::tab[Docker Compose]

```sh title="Terminal"
docker compose up -d
```

Compose replaces the container with one of the new image, and keeps the volume and the variables your Compose file sets.

:::

::::

## 6. Check the new version

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

The first start after an upgrade updates the data before Dezfil answers, so it can take longer than usual. If `curl` reports an error, wait a few seconds and run it again.

Then check the data in the app:

1. Sign in as an admin and open **Settings** > **System**.
2. In the **Status** card, click **Test** on the **Metadata database** row. You should see **Answered in** and a time, such as **Answered in 3 ms**.
3. Open a map you know. You should see its layers as before.

**Could not read the database.** means the database is at another version's level, or the test failed another way. It shows when an older version runs on data a newer one updated.

Keep the backup while you might go back. Before the next upgrade, move it away as [Back up](backup-and-restore.md#back-up) says. `docker image prune` removes the old images a download leaves without a tag.

## What the new version does when it starts

Before it answers any request, Dezfil brings its metadata database up to date. That database, `metadata.sqlite` in the volume, holds the maps, layers, accounts, workflows and settings.

- It applies each change the database lacks, in order, however many versions apart the two are.
- Each change is applied whole or not at all. If one fails, Dezfil does not start, its log names the error, and the next start tries that change again.
- Your datasets' files and `secret.key` stay as they are.

When an update also changes what your data means, such as who owns it, the changelog says so in a "Compatibility" entry.

## Go back to the old version

An upgraded database cannot be turned back in place. An older version starts on data a newer one updated without a warning, but cannot use it safely. To go back, restore your backup and start the old image.

> [!WARNING]
> Restoring replaces everything in the volume with the backup, so work done since the backup is lost. Step 1 keeps a copy of the current data.

### 1. Keep the current data

Run [step 1 of Restore](backup-and-restore.md#1-stop-dezfil-and-keep-the-current-data). It stops Dezfil, copies the volume as it is to `$HOME/dezfil-before-restore` and prints `Copied`. Go on only after `Copied`.

### 2. Restore the backup

Run the command of [step 2 of Restore](backup-and-restore.md#2-copy-the-backup-into-the-volume). It empties the volume, copies the backup in and prints `Restored`.

### 3. Start the old version

::::tabs

:::tab[Docker]

Note the container's variables first, as in [step 5](#5-start-the-new-version).

```sh title="Terminal"
docker rm -f dezfil
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data ghcr.io/dezfil/dezfil:<VERSION>
```

- `docker rm -f dezfil` removes the new version's container. The volume stays.
- `<VERSION>` is the version you wrote down in [step 1](#1-note-the-version-you-run), such as `0.1.0`. Add the `-e` variables your old container had, and its port.

:::

:::tab[Docker Compose]

In `compose.yaml`, give the image the version you wrote down in [step 1](#1-note-the-version-you-run), as in `image: ghcr.io/dezfil/dezfil:0.1.0`. Then:

```sh title="Terminal"
docker compose up -d
```

Compose replaces the container with one of the old version and keeps the volume. Keep the tag until you upgrade again.

:::

::::

Then check it as in [step 6](#6-check-the-new-version).

## From a development checkout

Stop `npm run dev`, back up the `data` folder as [A development checkout](backup-and-restore.md#a-development-checkout) shows, then run:

```sh title="Terminal"
git rev-parse --short HEAD
git pull
npm ci
npm run dev
```

- `git rev-parse` prints the commit you run, the version to go back to. Write it down.
- `npm ci` installs the packages the new version pins. `npm run dev` starts it, and it updates the data as the container does.

To go back, stop the server, put the copy in place of `data` as that section shows, run `git checkout <COMMIT>` and `npm ci`, and start it again.

## Troubleshooting

### Dezfil does not start after the upgrade

[Start-up](troubleshooting.md#start-up) shows what you see and fixes each line the log names. For a line it does not name, go back to the old version as above, and keep the line for a bug report.

### Step 1 prints an empty line or `<no value>`

The image was built from a checkout, not downloaded, so it names no version. Write down the checkout's commit instead, which `git rev-parse --short HEAD` prints there. To go back, check out that commit and build the image again.

### `git pull` says "You are not currently on a branch."

Your checkout is at a commit you checked out, as after going back. Run `git checkout main`, then `git pull` again.

### Settings says "The instance’s encryption key cannot read the saved address. Save it again."

The new container runs with another encryption key than the old one. Pass the same `DEZFIL_SECRET_KEY` as before, or none if you never set one, and replace the container as [Set a variable](configuration.md#set-a-variable) shows. Saved PostGIS connection passwords need that key too.

If that key is lost, [Back up and restore](backup-and-restore.md#saved-connections-or-service-addresses-fail-after-a-restore) says what to save again.

## Next steps

- [Back up and restore](backup-and-restore.md): what the backup holds, and moving to another machine.
- [Docker Compose](docker-compose.md): a Compose file for a lasting instance, its keys kept in `.env`.
- [Configuration](configuration.md): the variables you pass to the new container.
