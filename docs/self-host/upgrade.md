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

An upgrade builds the new version and replaces the container. Your data stays in the `dezfil-data` volume, and the new version updates it when it starts, so you back up first.

The commands use the names from [Install](../start/install.md) and [Docker Compose](docker-compose.md): a container and an image called `dezfil`, and a volume called `dezfil-data`. Run them in the `Dezfil` folder you cloned.

## 1. Read what changed

```sh title="Terminal"
git fetch
git diff HEAD origin/main -- CHANGELOG.md
```

- `git fetch` downloads the new version and leaves your files as they are.
- `git diff` shows what the new version adds to the changelog, on lines that start with `+`.

Read the entries that begin with "Breaking" or "Compatibility". They say what you or your API clients must change. The [changelog](../../CHANGELOG.md) lists every version.

## 2. Back up

Back up the volume as [Back up](backup-and-restore.md#back-up) shows: it stops Dezfil, copies the volume to `$HOME/dezfil-backup` and starts Dezfil again. You should see `metadata.sqlite` in the copy.

If you set `DEZFIL_SECRET_KEY`, in `.env` or with `-e`, keep its value too, apart from the backup: the volume does not hold it. [The encryption key](backup-and-restore.md#the-encryption-key) says why.

> [!NOTE]
> Let running tools and workflows finish before you back up. A tool run cut off by the stop ends as failed, a workflow run as **Interrupted**, and neither runs again by itself.

## 3. Install the new version

::::tabs

:::tab[Docker]

A new container gets none of the old one's `-e` variables. To see them before you remove it, run `docker inspect dezfil` and look under `Env`. The image's own variables are listed there too.

```sh title="Terminal"
docker tag dezfil dezfil:before-upgrade
git pull
docker build -t dezfil .
docker rm -f dezfil
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

- `docker tag` keeps your current image as `dezfil:before-upgrade`, the version you go back to if you need to.
- `git pull` brings your checkout to the new version, and `docker build` builds it under the name `dezfil`.
- `docker rm -f dezfil` stops and removes the old container. The volume stays.
- `docker run` starts the new version on the same volume. Add the `-e` variables your old container had.

:::

:::tab[Docker Compose]

```sh title="Terminal"
docker tag dezfil dezfil:before-upgrade
git pull
docker compose up -d --build
```

- `docker tag` keeps your current image as `dezfil:before-upgrade`, the version you go back to if you need to.
- `git pull` brings your checkout to the new version.
- `docker compose up -d --build` builds it, replaces the container and keeps the volume and the variables your Compose file sets.

:::

::::

## 4. Check the new version

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

**Could not read the database.** means the database is at another version's level, or did not answer. It shows when an older version runs on data a newer one updated.

> [!WARNING]
> If the version you upgraded from had no accounts, Dezfil opens on **Create the first account**. The first person to finish it becomes the admin and owns every existing map, dataset, workflow, connection and project. Keep the instance private until you have.

## What the new version does when it starts

Before it answers any request, Dezfil brings its metadata database up to date. That database, `metadata.sqlite` in the volume, holds the maps, layers, accounts, workflows and settings.

- It applies each change the database lacks, in order, however many versions apart the two are.
- Each change is applied whole or not at all. If one fails, the server stops with the error in its log, and the next start tries that change again.
- Your datasets' files and `secret.key` stay as they are.

Some updates also change what your data means. The first version that has one applies it once:

| Update | What it does to your data |
|---|---|
| Owners | Every map, dataset, workflow, connection and project goes to the recorded original account, the one made at setup, even when another account is the admin or it is deactivated. With no account yet, setup gives them to the account it makes. Other accounts start with nothing of their own. |
| Names | Dataset and connection names need to be unique only within one owner's work, so two accounts can each have a `roads`. |
| SQL names | Each account gets a SQL name, made from its display name and kept when the name changes. Other people's queries name its datasets with it, as [Query with SQL](../use/sql.md#other-peoples-datasets) shows. |
| SQL homes | Each map and workflow takes its owner's SQL name as its home. A plain dataset name in its SQL means that account's dataset, whoever opens it. |
| Deleted accounts | A deleted account keeps its SQL name for good, so maps that name its datasets never reach an account made later. |
| Who changed what | Maps and workflows show **Unknown** as the author of changes made before the update. Changes after it name the account that made them. |

These updates share nothing: every project keeps its owner, and has no members until its owner adds people.

## Go back to the old version

An upgraded database cannot be turned back in place. An older version starts on data a newer one updated without a warning, but cannot use it safely. To go back, restore your backup and start the image you kept.

> [!WARNING]
> Restoring replaces everything in the volume with the backup, so work done since the backup is lost. Step 1 keeps a copy of the current data.

### 1. Keep the current data

Run [step 1 of Restore](backup-and-restore.md#1-stop-dezfil-and-keep-the-current-data). It stops Dezfil and copies the volume as it is to `$HOME/dezfil-before-restore`. `ls "$HOME/dezfil-before-restore"` should list `metadata.sqlite`.

### 2. Put the old image back

```sh title="Terminal"
docker rm -f dezfil
docker tag dezfil:before-upgrade dezfil
```

- `docker rm -f dezfil` removes the new version's container. The volume stays.
- `docker tag` gives the name `dezfil` back to the image you kept.

`docker image ls dezfil` should list the tags `latest` and `before-upgrade` with one image ID.

### 3. Restore the backup

Run the command of [step 2 of Restore](backup-and-restore.md#2-copy-the-backup-into-the-volume). It empties the volume, copies the backup in and prints `Restored`.

### 4. Start the old version

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

Add the `-e` variables your old container had.

:::

:::tab[Docker Compose]

```sh title="Terminal"
docker compose up -d
```

Leave out `--build`: it would build the new version again.

:::

::::

Then check it as in [step 4](#4-check-the-new-version). Your checkout stays at the new version. To match it to the old one, run `git checkout <COMMIT>` with the commit you noted at the backup.

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

To go back, stop the server, put the copy in place of `data` as that section shows, run `git checkout <OLD_COMMIT>` and `npm ci`, and start it again.

## Troubleshooting

### Dezfil stops right after it starts

`docker ps -a` lists the `dezfil` container as `Exited`, or Docker Compose restarts it over and over. Read its log with `docker logs dezfil`. A line with `An error occurred while loading instrumentation hook` names the cause:

- **`Data directory /data is not writable`:** the volume's files belong to another user, often after a restore. Give them back to `node` as [Back up and restore](backup-and-restore.md#dezfil-stops-after-a-restore-and-its-log-says-data-directory-data-is-not-writable) shows, then start Dezfil again.
- **Anything else:** go back to the old version as above, and keep the log line for a bug report.

### `git pull` says "You are not currently on a branch."

Your checkout is at a commit you checked out, as after a move or going back. Run `git checkout main`, then `git pull` again.

### Settings says "The instance’s encryption key cannot read the saved address. Save it again."

The new container runs with another encryption key than the old one. Pass the same `DEZFIL_SECRET_KEY` as before, or none if you never set one, and replace the container. Saved PostGIS connection passwords need that key too.

If that key is lost, [Back up and restore](backup-and-restore.md#saved-connections-or-service-addresses-fail-after-a-restore) says what to save again.

## Next steps

- [Back up and restore](backup-and-restore.md): what the backup holds, and moving to another machine.
- [Docker Compose](docker-compose.md): a Compose file for a lasting instance, its keys kept in `.env`.
- [Configuration](configuration.md): the variables you pass to the new container.
