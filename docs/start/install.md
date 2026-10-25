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
  - agent
checked: none
order: 2
moved_from:
  - "/docs/start/run-it/"
---

## What you need

- **For Docker or Docker Compose:** Docker, on a 64-bit Intel, AMD or Arm machine. Compose also needs the `docker compose` command.
- **For a development checkout:** Node.js 24 or newer, npm and git.

Each release is published as the image `ghcr.io/dezfil/dezfil`, for `linux/amd64` and `linux/arm64`.

## Install

Docker is the quickest start. Docker Compose keeps the setup in a file, and starts Dezfil again after a crash or a Docker restart. From source is for working on the code.

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data ghcr.io/dezfil/dezfil
```

- `-p 127.0.0.1:3000:3000` serves Dezfil on port 3000 of this machine only. To use another port, change the first `3000`.
- `-v dezfil-data:/data` keeps everything Dezfil stores in the `dezfil-data` volume. Without it, a new container starts empty.
- `--name dezfil` is the name the [everyday commands](#everyday-commands) use.
- `ghcr.io/dezfil/dezfil` is the latest release. To run one version, add its tag, as in `ghcr.io/dezfil/dezfil:<VERSION>`.

The first `docker run` downloads the image, which takes a few minutes. Dezfil should be ready within 30 seconds of starting. Check it:

```sh title="Terminal"
curl http://localhost:3000/api/health
```

```json title="Output"
{"status":"ready"}
```

Then open <http://localhost:3000>.

:::

:::tab[Docker Compose]

Make a folder for the Compose file:

```sh title="Terminal"
mkdir dezfil
cd dezfil
```

Save this file as `compose.yaml` in the `dezfil` folder:

```yaml title="compose.yaml"
services:
  dezfil:
    image: ghcr.io/dezfil/dezfil
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

Start Dezfil:

```sh title="Terminal"
docker compose up -d
```

- `image: ghcr.io/dezfil/dezfil` runs the latest release. To run one version, add its tag, as in `ghcr.io/dezfil/dezfil:<VERSION>`.
- `127.0.0.1:3000:3000` serves Dezfil on port 3000 of this machine only. To use another port, change the first `3000`.
- `dezfil-data:/data` keeps everything Dezfil stores in the `dezfil-data` volume.
- `restart: unless-stopped` starts Dezfil again after a crash or a Docker restart, unless you stopped it.

For an instance that lasts, with its keys and backups, see [Docker Compose](../self-host/docker-compose.md).

The first start downloads the image, which takes a few minutes. Dezfil should be ready within 30 seconds of the container starting. Check it:

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

A checkout lacks two programs the container brings, `tippecanoe` for the tiles of large layers and Chromium for the map pictures the server draws, and [Development setup](../contribute/development-setup.md#add-the-programs-the-container-brings) shows how to add them.

To build the container image from your checkout, run `docker build -t dezfil .` in it. Then use `dezfil` in place of `ghcr.io/dezfil/dezfil` in the Docker commands.

[Development setup](../contribute/development-setup.md) covers the rest: the checks, the tests and what they need.

:::

::::

If the check answers `Internal Server Error` or `unready`, or nothing at all, the logs say why: run `docker logs dezfil` or `docker compose logs`, or read the terminal that runs `npm run dev`. See [Troubleshooting](../self-host/troubleshooting.md#start-up).

## First run

> [!WARNING]
> The first person to finish setup becomes the admin. Keep the instance private until you have created your account.

![The setup page, titled Create the first account, with Name, Email and Password fields and a Create account button](../images/start/setup-card.webp)

1. Open <http://localhost:3000>. Dezfil shows **Create the first account**. On a server, run `ssh -L 3000:127.0.0.1:3000 <YOUR_SERVER>` on your computer first, then open the address there.
2. Fill in **Name**, **Email** and **Password**. The password needs at least 8 characters, and very common passwords are refused.
3. Click **Create account**. You should see **Home**, signed in as the admin.

To add people, open **Users** in the side menu and click **Invite**. See [Users](../self-host/users.md).

## Everyday commands

::::tabs

:::tab[Docker]

| Task | Command |
|---|---|
| Stop | `docker stop dezfil` |
| Start | `docker start dezfil` |
| See the logs | `docker logs -f dezfil` |
| Check health | `curl http://localhost:3000/api/health` answers `{"status":"ready"}` |
| Back up | Stop Dezfil, then copy the `dezfil-data` volume with the commands in [Back up and restore](../self-host/backup-and-restore.md#back-up). |
| Upgrade | Follow [Upgrade](../self-host/upgrade.md): it downloads the new version, backs up, replaces the container and keeps a way back. |

:::

:::tab[Docker Compose]

Run these in the folder that holds `compose.yaml`.

| Task | Command |
|---|---|
| Stop | `docker compose stop` |
| Start | `docker compose start` |
| See the logs | `docker compose logs -f` |
| Check health | `curl http://localhost:3000/api/health` answers `{"status":"ready"}` |
| Back up | Stop Dezfil, then copy the `dezfil-data` volume with the commands in [Back up and restore](../self-host/backup-and-restore.md#back-up). |
| Upgrade | Follow [Upgrade](../self-host/upgrade.md): it downloads the new version, backs up, replaces the container and keeps a way back. |

:::

::::

A new version updates the stored data when it starts. To go back, restore your backup and run the version that made it, as [Go back to the old version](../self-host/upgrade.md#go-back-to-the-old-version) shows.

## Next steps

- [Your first map](first-map.md): add data and build a map.
- [Reverse proxy and HTTPS](../self-host/reverse-proxy.md): serve Dezfil under your own domain.
- [Configuration](../self-host/configuration.md): the settings that change how your instance runs.
- [Back up and restore](../self-host/backup-and-restore.md): back up and restore the data volume.
- [Upgrade](../self-host/upgrade.md): move to a new version and keep your data.
- [What leaves the instance](../self-host/what-leaves-the-instance.md): what your instance sends out, and what to settle before other people use it.
