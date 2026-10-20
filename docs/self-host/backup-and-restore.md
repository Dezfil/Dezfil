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

Everything your instance keeps is in one folder, the data folder: `/data` in the container, held in the `dezfil-data` volume. A backup is a copy of that folder, made while Dezfil is stopped.

The commands use the names from [Install](../start/install.md): a container and an image called `dezfil`, and a volume called `dezfil-data`. They work the same with Docker Compose, whose container is also called `dezfil`.

## Back up

```sh title="Terminal"
docker stop dezfil
mkdir "$HOME/dezfil-backup" && docker run --rm --user root --entrypoint sh \
  -v dezfil-data:/data:ro -v "$HOME/dezfil-backup:/backup" dezfil \
  -c 'cp -a /data/. /backup/'
docker start dezfil
```

- `docker stop dezfil` stops Dezfil, so no write lands halfway through the copy.
- `mkdir` makes the folder the copy goes into, outside the `Dezfil` folder, so a build leaves it out. If the folder exists, `mkdir` fails and `&&` skips the copy, so an earlier backup is never overwritten: move that one away first.
- `docker run --rm --user root --entrypoint sh` runs a shell as root in a throwaway container of your `dezfil` image, so it can read every file.
- `-v dezfil-data:/data:ro` mounts the volume read-only, and `-v "$HOME/dezfil-backup:/backup"` mounts the new folder.
- `cp -a /data/. /backup/` copies every file with its owner, mode and times.
- `docker start dezfil` starts Dezfil again on the same data, with the same variables.

Check the copy:

```sh title="Terminal"
ls "$HOME/dezfil-backup"
```

You should see `metadata.sqlite` in the list, and `secret.key` once Dezfil has made a key.

Write down the version and the settings you start Dezfil with. In the `Dezfil` folder, `git rev-parse --short HEAD` prints the commit you built. Your `compose.yaml`, or the `-e` variables of your `docker run` command, hold the settings.

> [!WARNING]
> The backup holds every account's password hash and, as `secret.key`, the encryption key. Keep it where only you can read it.

## What the backup holds

To see the sizes before you copy, sign in as an admin and open **Settings** > **System**. The **Storage** card lists what the data folder holds by kind, and **Free on the disk**.

| In the data folder | What it holds | In **Storage** |
|---|---|---|
| `metadata.sqlite`, with its `-wal` and `-shm` files when present | Accounts, sessions and API tokens; maps, layers, styles and published links; projects; workflows and their runs; connections; what admins saved in **Settings** | **Metadata database** |
| `tables/` | Your datasets as GeoParquet files, the shapes drawn on maps among them | **Tables** |
| `tiles/` | Tile archives built for large layers | **Tile archives** |
| `thumbnails/` | The pictures on map cards | **Thumbnails** |
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

If you set `DEZFIL_SECRET_KEY`, keep a copy of its value, such as the `.env` file Docker Compose reads, in another place than the backup folder. A restore needs both, and either one alone cannot read the saved passwords.

> [!WARNING]
> A restore needs the key the backup was made with. With another key, Dezfil cannot read the saved connection passwords and service addresses, and you enter each one again.

## Restore

Restoring replaces everything in the volume with the backup, and work done since the backup is lost. Step 1 keeps a copy of the current data, in case you want it later.

Start the version that made the backup.

### 1. Stop Dezfil and keep the current data

```sh title="Terminal"
docker stop dezfil
mkdir "$HOME/dezfil-before-restore" && docker run --rm --user root --entrypoint sh \
  -v dezfil-data:/data:ro -v "$HOME/dezfil-before-restore:/backup" dezfil \
  -c 'cp -a /data/. /backup/'
```

It is the backup command with another folder, and you check it the same way. Skip the copy if the volume holds nothing you need.

### 2. Copy the backup into the volume

```sh title="Terminal"
docker run --rm --user root --entrypoint sh \
  -v dezfil-data:/data -v "$HOME/dezfil-backup:/backup:ro" dezfil \
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

`docker start` keeps the container's variables, `DEZFIL_SECRET_KEY` included. Within 30 seconds, check its health:

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

1. Copy the backup folder to the new machine, into your home folder. There, `ls "$HOME/dezfil-backup"` should list `metadata.sqlite`.
2. Clone Dezfil there with `git clone https://github.com/Dezfil/Dezfil.git`, then run `git checkout <COMMIT>` in the `Dezfil` folder with the commit you noted. `git rev-parse --short HEAD` should print that commit.
3. In the `Dezfil` folder, build the image with `docker build -t dezfil .`. `docker image ls dezfil` should then list it.
4. Run the command of [step 2](#2-copy-the-backup-into-the-volume) of Restore. It creates the `dezfil-data` volume, fills it with the backup and prints `Restored`.
5. Start Dezfil with the `docker run` command of [Install](../start/install.md) and the variables the old instance had, `DEZFIL_SECRET_KEY` included. With Docker Compose, copy your `compose.yaml`, and `.env` if you have one, into the `Dezfil` folder, then run `docker compose up -d`. You should see your maps when you sign in.

## A development checkout

A checkout keeps its data in its `data` folder, or in the folder `DEZFIL_DATA_DIR` names. Stop the server, then copy the folder:

```sh title="Terminal"
cp -a data "$HOME/dezfil-data-backup"
```

To restore, stop the server, move the current folder aside and put the copy in its place:

```sh title="Terminal"
mv data data.before-restore
cp -a "$HOME/dezfil-data-backup" data
```

Each `cp -a` needs a target that does not exist yet. If it exists, `cp` puts the copy inside it.

## Troubleshooting

### Dezfil stops after a restore, and its log says "Data directory /data is not writable"

The restored files belong to another user. `docker logs dezfil` shows the line. Give the files to `node`, then run `docker start dezfil`:

```sh title="Terminal"
docker run --rm --user root --entrypoint sh -v dezfil-data:/data dezfil -c 'chown -R node:node /data'
```

### Dezfil shows "Create the first account" after a restore or a move

The container runs on an empty volume, not the one you restored into. Check which volume it uses:

```sh title="Terminal"
docker inspect --format '{{range .Mounts}}{{.Name}}{{end}}' dezfil
```

```text title="Output"
dezfil-data
```

If it prints another name, run `docker rm -f dezfil`. Then start Dezfil again with `-v dezfil-data:/data` in the `docker run` command, or with `name: dezfil-data` for the volume in `compose.yaml`.

### Saved connections or service addresses fail after a restore

Browsing or importing from a saved connection fails with "An unexpected server error occurred.", or a service address in **Settings** says "The instance’s encryption key cannot read the saved address. Save it again." Dezfil runs with another key than the one the backup was made with.

Run Dezfil with the backup's key: the same `DEZFIL_SECRET_KEY` value, or the backup's `secret.key` with the variable unset, since a set variable wins.

If that key is lost, save each address again. Delete each connection in **Connections** and add it again: its snapshots keep their data, but they cannot refresh.

## Next steps

- [Configuration](configuration.md): `DEZFIL_DATA_DIR`, `DEZFIL_SECRET_KEY` and the other variables.
