---
title: "Back up and restore"
summary: "Back up your instance's data folder and its encryption key, then restore them on the same machine or a new one."
read_when:
  - "you want a backup before an upgrade, a move or a big change"
  - "you want to know which files hold your maps, data and accounts"
  - "you need to restore an instance from a backup, or move it to another machine"
  - "you want to know where the encryption key is and whether DEZFIL_SECRET_KEY must be kept with the backup"
  - "saved database connections or service addresses fail after a restore"
audience:
  - operator
checked: none
order: 5
moved_from:
  - "/docs/operate/runbook/"
---

Everything your instance keeps is in one folder, the data folder: `/data` in the container, held in the `dezfil-data` volume. A backup is a copy of that folder, made while Dezfil is stopped. The variables you start Dezfil with stay outside it.

The commands use the names from [Install](../start/install.md): a container called `dezfil`, the image `ghcr.io/dezfil/dezfil` and a volume called `dezfil-data`. They work the same with Docker Compose, whose container is also called `dezfil`. If you run a version by its tag, add the tag to the image name.

## Back up

```sh title="Terminal"
docker stop dezfil
mkdir "$HOME/dezfil-backup" && docker run --rm --user root --entrypoint sh \
  -e OWNER="$(id -u):$(id -g)" \
  -v dezfil-data:/data:ro -v "$HOME/dezfil-backup:/backup" ghcr.io/dezfil/dezfil \
  -c 'cp -a /data/. /backup/ && chown -R "$OWNER" /backup && chmod 700 /backup && echo Copied'
docker start dezfil
```

- `docker stop dezfil` stops Dezfil, so no write lands halfway through the copy.
- `mkdir` makes the folder in your home folder. If the folder exists, `mkdir` fails and `&&` skips the copy, so no earlier backup is overwritten.
- `docker run --rm --user root --entrypoint sh` runs a shell as root in a throwaway container of Dezfil's image, so it can read every file. `-e OWNER=…` passes it your user and group.
- `-v dezfil-data:/data:ro` mounts the volume read-only, and `-v "$HOME/dezfil-backup:/backup"` mounts the new folder.
- `cp -a /data/. /backup/` copies every file with its mode and times. `chown -R "$OWNER" /backup` gives the copy to you, and `chmod 700 /backup` lets only you open the folder.
- `docker start dezfil` starts Dezfil again on the same data, with the same variables.

When the copy is done, it prints:

```text title="Output"
Copied
```

`File exists` instead means an earlier backup is there: move it away, as with `mv "$HOME/dezfil-backup" "$HOME/dezfil-backup-1"`, and run the commands again. The folder holds `metadata.sqlite`, and `secret.key` once Dezfil has made a key.

Also write down the version, which [step 1 of Upgrade](upgrade.md#1-note-the-version-you-run) prints, and the settings. The settings are your `-e` variables, listed as [Set a variable](configuration.md#set-a-variable) shows, or `compose.yaml` and `.env`.

> [!WARNING]
> The backup holds every account's password hash and, as `secret.key`, the encryption key. Keep every copy of it where only you can read it, as the command leaves this one.

## What the backup holds

To see the sizes before you copy, sign in as an admin and open **Settings** > **System**. The **Storage** card lists what the data folder holds by kind, and **Free on the disk**.

| In the data folder | What it holds | In **Storage** |
|---|---|---|
| `metadata.sqlite`, with its `-wal` and `-shm` files when present | Accounts, sessions, API tokens and people's AI keys; maps, layers, styles and published links; projects; workflows and their runs; connections; what admins saved in **Settings** | **Metadata database** |
| `tables/` | Your datasets as GeoParquet files, the shapes drawn on maps among them | **Tables** |
| `tiles/` | Tile archives built for large layers | **Tile archives** |
| `thumbnails/` | The pictures on map cards | **Thumbnails** |
| `profile-pictures/` | Each person's picture, as Dezfil keeps it | **Profile pictures** |
| `templates/` | Downloaded templates | **Templates** |
| `cache/` | Answers from the address finder, travel time and OpenStreetMap | **Service caches** |
| `secret.key` | The encryption key, once Dezfil has made one | **Other** |
| `assistant-models.json` | Your model catalogue file, if you added one | **Other** |
| `tmp/`, `exports/` | Work in progress, removed at the next start | **Leftover files** |

Other folders hold Dezfil's own records, such as who owns each file. Publishing a map writes no files of its own. Copy the whole folder every time, as the command does.

For a smaller copy, click **Clear all** in the **Service caches** row before you back up. Dezfil asks the services again the next time it needs an answer.

> [!NOTE]
> Restore a whole backup, never part of one. When it starts, Dezfil removes the table files that `metadata.sqlite` does not name.

## The encryption key

Dezfil encrypts two kinds of saved secrets with one key: the passwords of database connections, and the service addresses an admin saves in **Settings** > **Data & services** or **Libraries**. Account passwords are hashed and need no key.

The key is in one of two places:

| Where | When | What to keep |
|---|---|---|
| `secret.key` in the data folder | Dezfil writes it, readable by its owner only, the first time it needs a key, unless `DEZFIL_SECRET_KEY` is set | Nothing more: the backup holds it |
| The `DEZFIL_SECRET_KEY` variable | You set it to 64 hexadecimal characters | Its exact value, kept apart from the backup |

To see which, open **Settings** > **System**. In **Server settings**, the **Encryption key** row reads **secret.key in the data folder**, **Not created yet** or **Set**. **Set** means the key comes from `DEZFIL_SECRET_KEY`, and the **Source** column reads **Environment**.

If you set `DEZFIL_SECRET_KEY`, keep its value, as in the `.env` file of [Docker Compose](docker-compose.md), apart from the backup folder. A restore needs it, unless the backup holds the same key as `secret.key`, as it does for a key you moved from the file into the variable. Without the key, [saved connections and addresses fail](#saved-connections-or-service-addresses-fail-after-a-restore).

To move a key Dezfil made into the variable, see [Keep the key you have](docker-compose.md#keep-the-key-you-have).

## Restore

Restoring replaces everything in the volume with the backup, and work done since the backup is lost. Step 1 keeps a copy of the current data.

A newer version brings a restored backup up to date when it starts. An older version cannot use data a newer one updated: after an upgrade, [go back to the old version](upgrade.md#go-back-to-the-old-version) instead.

### 1. Stop Dezfil and keep the current data

```sh title="Terminal"
docker stop dezfil
mkdir "$HOME/dezfil-before-restore" && docker run --rm --user root --entrypoint sh \
  -e OWNER="$(id -u):$(id -g)" \
  -v dezfil-data:/data:ro -v "$HOME/dezfil-before-restore:/backup" ghcr.io/dezfil/dezfil \
  -c 'cp -a /data/. /backup/ && chown -R "$OWNER" /backup && chmod 700 /backup && echo Copied'
```

It is the backup command with another folder. Without `Copied`, as after `File exists`, move the earlier copy away and run it again: step 2 empties the volume.

If the volume holds nothing you need, run only `docker stop dezfil`: the restore needs Dezfil stopped.

### 2. Copy the backup into the volume

```sh title="Terminal"
docker run --rm --user root --entrypoint sh \
  -v dezfil-data:/data -v "$HOME/dezfil-backup:/backup:ro" ghcr.io/dezfil/dezfil \
  -c 'test -f /backup/metadata.sqlite && find /data -mindepth 1 -delete &&
      cp -a /backup/. /data/ && chown -R node:node /data && echo Restored'
```

- `:ro` mounts the backup read-only, so the restore cannot change it.
- `test -f /backup/metadata.sqlite` stops the command before it deletes anything if the folder holds no backup. It then prints nothing.
- `find /data -mindepth 1 -delete` empties the volume, so no file of the current data stays among the restored ones.
- `cp -a /backup/. /data/` copies the backup in, and `chown -R node:node /data` gives every file to `node`, the user Dezfil runs as.

When the restore is done, it prints:

```text title="Output"
Restored
```

### 3. Start Dezfil and check it

```sh title="Terminal"
docker start dezfil
```

`docker start` keeps the container's variables. Within 30 seconds, check its health:

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

Then sign in and open **Maps**. You should see your maps as they were at the backup.

> [!NOTE]
> A restore brings back accounts, sessions and API tokens as they were at the backup. Accounts deleted since return, and tokens revoked since work again. Check the accounts in **Users** before you let people in.

## Move to another machine

1. From the old machine, copy the backup folder into your home folder on the new one:

   ```sh title="Terminal"
   scp -rp "$HOME/dezfil-backup" <USER>@<NEW_HOST>:
   ```

   `-p` keeps each file's mode, so only you can read the copy. There, `ls "$HOME/dezfil-backup"` should list `metadata.sqlite`, and `secret.key` if the old folder held one.
2. Download the version you noted there, with `docker pull ghcr.io/dezfil/dezfil:<VERSION>`. `docker image ls ghcr.io/dezfil/dezfil` should then list it.
3. Run the command of [step 2](#2-copy-the-backup-into-the-volume) of Restore. It creates the `dezfil-data` volume, fills it with the backup and prints `Restored`.
4. Start Dezfil on the volume, with the version and the settings the old instance had:

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data ghcr.io/dezfil/dezfil:<VERSION>
```

Add the `-e` variables of the old instance, `DEZFIL_SECRET_KEY` too if it had one.

:::

:::tab[Docker Compose]

Copy your `compose.yaml`, and `.env` if you have one, into a folder of their own. Give the image the version you noted, as in `image: ghcr.io/dezfil/dezfil:<VERSION>`, then run:

```sh title="Terminal"
docker compose up -d
```

Compose says the `dezfil-data` volume "already exists but was not created by Docker Compose". It uses the volume all the same.

:::

::::

Behind a reverse proxy, set `DEZFIL_TRUSTED_PROXIES` to the new machine's proxy address, which [Trust the proxy](reverse-proxy.md#2-trust-the-proxy) prints.

You should see your maps when you sign in.

## A development checkout

A checkout keeps its data in its `data` folder. If you set `DEZFIL_DATA_DIR`, use the folder it names in place of `data`. Stop the server, then copy the folder from the `Dezfil` folder:

```sh title="Terminal"
mkdir "$HOME/dezfil-data-backup" && cp -a data/. "$HOME/dezfil-data-backup/" && echo Copied
```

It prints `Copied`, or `File exists` when an earlier copy is there: move that one away first.

To restore, stop the server, move the current folder aside and put the copy in its place:

```sh title="Terminal"
test ! -e data.before-restore && mv data data.before-restore &&
  cp -a "$HOME/dezfil-data-backup" data && echo Restored
```

It prints `Restored`.

Nothing printed means a `data.before-restore` folder is in the way: move it away and run the command again. `No such file or directory` means there is no `data` folder yet, as in a new checkout: run only the `cp -a` line.

## Troubleshooting

### After a restore, the log says "Data directory /data is not writable"

Every page, health included, answers `Internal Server Error`, and `docker logs dezfil` shows the line. The restored files belong to another user. When only the files inside `/data` do, the line is `attempt to write a readonly database` instead. Either way, give them to `node`, then restart Dezfil:

```sh title="Terminal"
docker run --rm --user root --entrypoint sh -v dezfil-data:/data ghcr.io/dezfil/dezfil -c 'chown -R node:node /data'
docker restart dezfil
```

### Dezfil shows "Create the first account" after a restore or a move

The container runs on an empty volume, not the one you restored into. Check which volume it uses:

```sh title="Terminal"
docker inspect --format '{{range .Mounts}}{{.Name}}{{end}}' dezfil
```

```text title="Output"
dezfil-data
```

If it prints another name, start Dezfil again on `dezfil-data`. Do not create an account there: the first one becomes the admin.

::::tabs

:::tab[Docker]

A new container gets none of the old one's `-e` variables or its image's version: list them as [Set a variable](configuration.md#set-a-variable) shows, then start a new one with them, `DEZFIL_SECRET_KEY` too if you set one:

```sh title="Terminal"
docker rm -f dezfil
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data ghcr.io/dezfil/dezfil
```

:::

:::tab[Docker Compose]

Give the volume `name: dezfil-data` in `compose.yaml`, as [Docker Compose](docker-compose.md#2-write-the-compose-file) shows, then run `docker compose up -d`.

:::

::::

### Saved connections or service addresses fail after a restore

Browsing or importing from a saved connection fails with "An unexpected server error occurred.", or a service address in **Settings** says "The instance’s encryption key cannot read the saved address. Save it again." Dezfil runs with another key than the one the backup was made with.

Run Dezfil with the backup's key: the same `DEZFIL_SECRET_KEY` value, or the backup's `secret.key` with the variable unset. A container keeps its variables, so replace it as [Set a variable](configuration.md#set-a-variable) shows.

If that key is lost, save each address again and people re-add their AI keys. Delete each connection in **Connections** and add it again: its snapshots keep their data but cannot refresh.

## Next steps

- [Upgrade](upgrade.md): back up, then move to a new version.
- [Docker Compose](docker-compose.md): keep the encryption key in `.env`, outside the data folder.
- [Users](users.md): recover the admin account when nobody can sign in.
- [Storage and programs](configuration/storage.md): `DEZFIL_DATA_DIR`, `DEZFIL_SECRET_KEY` and the programs Dezfil runs.
