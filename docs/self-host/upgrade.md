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

An upgrade builds the new version while the old one runs, backs up the data, then replaces the container. The data stays in the `dezfil-data` volume, and the new version updates it when it starts.

The commands use the names from [Install](../start/install.md) and [Docker Compose](docker-compose.md): a container and an image called `dezfil`, and a volume called `dezfil-data`. Run them in the `Dezfil` folder you cloned.

## 1. Read what changed

```sh title="Terminal"
git fetch
git diff HEAD origin/main -- CHANGELOG.md
```

- `git fetch` downloads the new version and leaves your files as they are.
- `git diff` shows what the new version adds to the changelog, on lines that start with `+`.

Read the entries that begin with "Breaking" or "Compatibility". They say what you or your API clients must change, and what the new version changes in your data. The [changelog](../../CHANGELOG.md) lists every version.

## 2. Build the new version

Dezfil keeps running while the new version builds.

::::tabs

:::tab[Docker]

```sh title="Terminal"
git rev-parse --short HEAD
docker tag "$(docker inspect --format '{{.Image}}' dezfil)" dezfil:before-upgrade
git pull
docker build -t dezfil .
```

:::

:::tab[Docker Compose]

```sh title="Terminal"
git rev-parse --short HEAD
docker tag "$(docker inspect --format '{{.Image}}' dezfil)" dezfil:before-upgrade
git pull
docker compose build
```

:::

::::

- `git rev-parse` prints the commit you run. Write it down: it is the version you go back to.
- `docker tag` keeps the image your container runs as `dezfil:before-upgrade`.
- `git pull` brings your checkout to the new version, and the build gives it the name `dezfil`. The running container keeps its own image.

## 3. Back up

Let running tools and workflows finish. Then back up the volume as [Back up](backup-and-restore.md#back-up) shows: it stops Dezfil, copies the volume to `$HOME/dezfil-backup`, prints `Copied` and starts the old version again.

If you set `DEZFIL_SECRET_KEY`, in `.env` or with `-e`, keep its value too, apart from the backup: the volume does not hold it. [The encryption key](backup-and-restore.md#the-encryption-key) says why.

> [!NOTE]
> A tool run cut off by a stop ends as failed, a workflow run as **Interrupted**, and neither runs again by itself.

## 4. Start the new version

> [!WARNING]
> If the version you upgrade from had no accounts, Dezfil opens on **Create the first account**. The first person to finish it becomes the admin and owns every existing map, dataset, workflow, connection and project. Keep the instance private until you have, as in [First run](../start/install.md#first-run).

::::tabs

:::tab[Docker]

A new container gets none of the old one's options. To see its variables before you remove it, run `docker inspect dezfil` and look under `Env`. The image's own variables are listed there too.

```sh title="Terminal"
docker rm -f dezfil
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
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

## 5. Check the new version

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

Run [step 1 of Restore](backup-and-restore.md#1-stop-dezfil-and-keep-the-current-data). It stops Dezfil, copies the volume as it is to `$HOME/dezfil-before-restore` and prints `Copied`.

### 2. Put the old image back

With Docker, note the container's variables first, as in [step 4](#4-start-the-new-version).

```sh title="Terminal"
docker rm -f dezfil
docker tag dezfil:before-upgrade dezfil
```

- `docker rm -f dezfil` removes the new version's container. The volume stays.
- `docker tag` gives the name `dezfil` back to the image you kept.

`docker image ls dezfil` should list the tags `latest` and `before-upgrade` with one image ID.

Without a `dezfil:before-upgrade` image, build the old version instead: run `git checkout <COMMIT>` with the commit you wrote down, then `docker build -t dezfil .`, or `docker compose build`.

### 3. Restore the backup

Run the command of [step 2 of Restore](backup-and-restore.md#2-copy-the-backup-into-the-volume). It empties the volume, copies the backup in and prints `Restored`.

### 4. Start the old version

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

Add the `-e` variables your old container had, and its port.

:::

:::tab[Docker Compose]

```sh title="Terminal"
docker compose up -d
```

Leave out `--build`: it would build your checkout's version again.

:::

::::

Then check it as in [step 5](#5-check-the-new-version). To bring your checkout back to the old version too, run `git checkout <COMMIT>`.

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

### `git pull` says "You are not currently on a branch."

Your checkout is at a commit you checked out, as after a move or going back. Run `git checkout main`, then `git pull` again.

### Settings says "The instance’s encryption key cannot read the saved address. Save it again."

The new container runs with another encryption key than the old one. Pass the same `DEZFIL_SECRET_KEY` as before, or none if you never set one, and replace the container as [Set a variable](configuration.md#set-a-variable) shows. Saved PostGIS connection passwords need that key too.

If that key is lost, [Back up and restore](backup-and-restore.md#saved-connections-or-service-addresses-fail-after-a-restore) says what to save again.

## Next steps

- [Back up and restore](backup-and-restore.md): what the backup holds, and moving to another machine.
- [Docker Compose](docker-compose.md): a Compose file for a lasting instance, its keys kept in `.env`.
- [Configuration](configuration.md): the variables you pass to the new container.
