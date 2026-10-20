---
title: "Install"
summary: "Install Dezfil with Docker, Docker Compose or from source, create the admin account, and keep the instance running day to day."
read_when:
  - "you want Dezfil running on your computer or a server"
  - "you choose between Docker, Docker Compose and a development checkout"
  - "you create the first admin account"
  - "you stop, start, upgrade, back up or check a running instance"
audience:
  - user
  - operator
  - developer
checked: none
order: 2
moved_from:
  - "/docs/start/run-it/"
---

## What you need

- **For Docker or Docker Compose:** Docker and git. Compose also needs the `docker compose` command.
- **For a development checkout:** Node.js 24 or newer, npm and git.

There is no published image to pull. You clone the repository and build the image from it.

## Install

Docker is the quickest start. Docker Compose keeps the setup in a file, and starts Dezfil again after a crash or a Docker restart. From source is for working on the code.

::::tabs

:::tab[Docker]

```sh title="Terminal"
git clone https://github.com/Dezfil/Dezfil.git
cd Dezfil
docker build -t dezfil .
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data dezfil
```

- `-p 127.0.0.1:3000:3000` serves Dezfil on port 3000 of this machine only. To use another port, change the first `3000`.
- `-v dezfil-data:/data` keeps everything Dezfil stores in the `dezfil-data` volume. Without it, a new container starts empty.
- `--name dezfil` is the name the [everyday commands](#everyday-commands) use.

The first build takes a few minutes: it compiles the app and its tile builder. Dezfil should be ready within 30 seconds of `docker run`. Check it:

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

Then open <http://localhost:3000>.

:::

:::tab[Docker Compose]

```sh title="Terminal"
git clone https://github.com/Dezfil/Dezfil.git
cd Dezfil
```

Save this file as `compose.yaml` in the `Dezfil` folder:

```yaml title="compose.yaml"
services:
  dezfil:
    build: .
    image: dezfil
    container_name: dezfil
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - dezfil-data:/data
    restart: unless-stopped

volumes:
  dezfil-data:
    name: dezfil-data
```

Build the image and start Dezfil:

```sh title="Terminal"
docker compose up -d --build
```

- `build: .` builds the image from the repository and `image: dezfil` names it.
- `127.0.0.1:3000:3000` serves Dezfil on port 3000 of this machine only. To use another port, change the first `3000`.
- `dezfil-data:/data` keeps everything Dezfil stores in the `dezfil-data` volume.
- `restart: unless-stopped` starts Dezfil again after a crash or a Docker restart, unless you stopped it.

The first build takes a few minutes: it compiles the app and its tile builder. Dezfil should be ready within 30 seconds of the container starting. Check it:

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

Then open <http://localhost:3000>.

:::

:::tab[From source]

Use this to work on Dezfil's code. It runs a development server that reloads as you edit.

```sh title="Terminal"
git clone https://github.com/Dezfil/Dezfil.git
cd Dezfil
npm ci
npm run dev
```

- `npm ci` installs the exact package versions the lockfile pins.
- `npm run dev` serves Dezfil on port 3000 and keeps your data in `./data`. Set `PORT` for another port, `DEZFIL_DATA_DIR` for another folder.
- `npm run dev` listens on every network interface. Run `npm run dev -- -H 127.0.0.1` to keep it on this machine.

In another terminal, check that Dezfil is ready:

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

Then open <http://localhost:3000>.

To stop Dezfil, press Ctrl+C in its terminal. To upgrade, stop it, run `git pull` and `npm ci`, then `npm run dev` again. To back up, stop it and copy the `data` folder.

The container brings two programs a checkout lacks:

- `tippecanoe` builds tiles for large layers. Install it on your `PATH`.
- Chromium draws map pictures on the server: the pictures on map cards, and the images the API and the assistant make. Set `DEZFIL_CHROMIUM_PATH` if it is not at `/usr/bin/chromium`. The builder's own image download works without it.

[Development setup](../contribute/development-setup.md) covers the rest: the checks, the tests and what they need.

:::

::::

If the check answers `unready`, or nothing at all, the logs say why: run `docker logs dezfil` or `docker compose logs`, or read the terminal that runs `npm run dev`.

## First run

> [!WARNING]
> The first person to finish setup becomes the admin. Keep the instance private until you have created your account.

![The setup page, titled Create the first account, with Name, Email and Password fields and a Create account button](../images/start/setup-card.webp)

1. Open <http://localhost:3000>. Dezfil shows **Create the first account**. On a server, run `ssh -L 3000:127.0.0.1:3000 <YOUR_SERVER>` on your computer first, then open the address there.
2. Fill in **Name**, **Email** and **Password**. The password needs at least 8 characters, and very common passwords are refused.
3. Click **Create account**. You should see **Home**, signed in as the admin.

To add people, open **Users** in the side menu and click **Invite**.

## Everyday commands

::::tabs

:::tab[Docker]

| Task | Command |
|---|---|
| Stop | `docker stop dezfil` |
| Start | `docker start dezfil` |
| See the logs | `docker logs -f dezfil` |
| Check health | `curl http://localhost:3000/api/health` answers `{"status":"ready"}` |
| Back up | Stop Dezfil, then copy the `dezfil-data` volume with the commands in [Back up and restore](../self-host/backup-and-restore.md#full-backup-and-restore). |
| Upgrade | Back up. In the `Dezfil` folder, run `git pull` and `docker build -t dezfil .`. Then run `docker stop dezfil`, `docker rm dezfil` and the install's `docker run` command. |

:::

:::tab[Docker Compose]

Run these in the `Dezfil` folder.

| Task | Command |
|---|---|
| Stop | `docker compose stop` |
| Start | `docker compose start` |
| See the logs | `docker compose logs -f` |
| Check health | `curl http://localhost:3000/api/health` answers `{"status":"ready"}` |
| Back up | Stop Dezfil, then copy the `dezfil-data` volume with the commands in [Back up and restore](../self-host/backup-and-restore.md#full-backup-and-restore). |
| Upgrade | Back up. Run `git pull`, then `docker compose up -d --build`. Compose replaces the container and keeps the volume. |

:::

::::

A new version updates the stored data when it starts. To go back, restore your backup and run the version that made it.

## Next steps

- [Your first map](first-map.md): add data and build a map.
- [Configuration](../self-host/configuration.md): the settings that change how your instance runs.
- [Back up and restore](../self-host/backup-and-restore.md#full-backup-and-restore): back up and restore the data volume.
- [What leaves the instance](../self-host/what-leaves-the-instance.md): what your instance sends out, and what to settle before other people use it.
