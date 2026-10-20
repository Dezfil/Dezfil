---
title: "Docker Compose"
summary: "Run Dezfil as a lasting instance with Docker Compose: the data in a named volume, the keys in a file, a restart policy and a health check."
read_when:
  - "you want Dezfil to keep running on a server and come back after a crash or a reboot"
  - "you move from the quick start to an instance people rely on"
  - "you want to set the encryption key with `DEZFIL_SECRET_KEY` instead of the one Dezfil makes"
  - "you want to keep provider keys out of `compose.yaml`"
  - "you want Docker to tell you whether Dezfil is healthy"
audience:
  - operator
checked: none
order: 1
---

One Compose file holds a lasting setup: the volume that keeps the data, a file with the keys, a restart policy and a health check.

- **You need:** Docker with the `docker compose` command, on the machine that serves Dezfil.
- **The code:** the `Dezfil` folder from [Install](../start/install.md). On a new machine, run `git clone https://github.com/Dezfil/Dezfil.git`.
- **For the key:** `openssl`, which makes a random encryption key.

## 1. Write the Compose file

In the `Dezfil` folder, save this file as `compose.yaml`:

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
    env_file: .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  dezfil-data:
    name: dezfil-data
```

- `build: .` builds the image from the folder, and `image: dezfil` names it.
- `127.0.0.1:3000:3000` serves Dezfil on port 3000 of this machine only. To serve it under your domain, see [Reverse proxy and HTTPS](reverse-proxy.md).
- `dezfil-data:/data` keeps everything Dezfil stores in the `dezfil-data` volume. `name: dezfil-data` keeps that exact name; without it, Compose adds the folder's name, as in `dezfil_dezfil-data`.
- `env_file: .env` passes the keys you write in step 2 to Dezfil.
- `restart: unless-stopped` starts Dezfil again after a crash and whenever Docker starts, unless you stopped it with `docker compose stop`.
- `healthcheck` asks `/api/health` from inside the container every 30 seconds. After three failures in a row, Docker marks the container unhealthy, but it does not restart it for that.
- `logging` caps the container's logs at three files of 10 MB each, so a long-running instance does not fill the disk.

If you used the Compose tab of Install, replace its `compose.yaml` with this one. Both use the `dezfil-data` volume, so your data stays.

## 2. Make the keys file

If the `dezfil-data` volume holds data already, [keep the key you have](#keep-the-key-you-have) instead of running this command.

```sh title="Terminal"
printf 'DEZFIL_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

- `DEZFIL_SECRET_KEY` encrypts the passwords of saved database connections and the service addresses an admin saves in **Settings**. It takes 64 hex characters.
- `openssl rand -hex 32` makes a random key of that length.
- `chmod 600 .env` lets only your user read the file. Git ignores `.env`, and Docker leaves it out of the image it builds.

Without this variable, Dezfil makes a key itself, the first time it needs one, and keeps it in the volume as `secret.key`. With the key in `.env` from the first start, a copy of the volume alone cannot read those passwords.

To turn on the assistant, add its key to the same file:

```sh title=".env"
DEZFIL_SECRET_KEY=<64_HEX_CHARACTERS>
ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_KEY>
```

For OpenAI, the line is `OPENAI_API_KEY=<YOUR_OPENAI_KEY>`. [Set up the assistant](assistant.md) covers the models and how to check that it answers.

When you change `.env` later, run `docker compose up -d`. Compose replaces the container and keeps the volume.

> [!WARNING]
> Keep a copy of `.env` in a safe place, apart from the volume's backups. Without its key, Dezfil cannot read the saved connection passwords and service addresses, and they must be entered again.

## 3. Start Dezfil

```sh title="Terminal"
docker compose up -d --build
```

The first build takes a few minutes. About a minute after Dezfil starts, check its health:

```sh title="Terminal"
docker inspect --format '{{.State.Health.Status}}' dezfil
```

```text title="Output"
healthy
```

`starting` means the first check has not passed yet. Ask again after 30 seconds.

Then open <http://localhost:3000>. On a new volume, Dezfil asks for the first account, which becomes the admin: see [First run](../start/install.md#first-run).

## 4. Check the keys

1. Sign in as an admin and open **Settings** > **System**.
2. In **Server settings**, find the **Encryption key** row. You should see **Set**, with the source **Environment**.
3. If you added an assistant key, the **Anthropic credential** or **OpenAI credential** row shows **Set** too.

**Set** shows that the variable reached Dezfil. Dezfil reads the key's form the first time it uses the key; [Troubleshooting](#troubleshooting) has the message for a key of the wrong form.

## 5. Check the restart policy

```sh title="Terminal"
docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' dezfil
```

```text title="Output"
unless-stopped
```

Docker restarts Dezfil only while Docker itself runs. On Linux with systemd, make Docker start when the machine boots:

```sh title="Terminal"
sudo systemctl enable docker.service containerd.service
```

A restart ends the tool and workflow runs in progress. When Dezfil starts again, it records that the server stopped them and repeats nothing, so people run them again.

## Keep the key you have

A volume that holds data may hold a key Dezfil made, as `secret.key`. Everything it encrypted needs that same key. Print it:

```sh title="Terminal"
docker run --rm -v dezfil-data:/data:ro --entrypoint cat dezfil /data/secret.key
```

```text title="Output"
<64_HEX_CHARACTERS>
```

- `-v dezfil-data:/data:ro` mounts the volume read-only.
- `--entrypoint cat dezfil /data/secret.key` prints the key file with the `dezfil` image you built.

If you see `cat: /data/secret.key: No such file or directory` instead, Dezfil has made no key yet, and a new key from step 2 is fine.

Otherwise, write the key to `.env` as the line `DEZFIL_SECRET_KEY=<64_HEX_CHARACTERS>`, run `chmod 600 .env`, and go on with step 3. The volume keeps its `secret.key`, so its backups still hold that key.

## Troubleshooting

**Compose says the container name "/dezfil" is already in use.** A container from Install's Docker command has that name. Remove it with `docker rm -f dezfil`, then run `docker compose up -d` again. The volume keeps your data.

**Compose says it cannot find `.env`.** Make the keys file of step 2 in the folder that holds `compose.yaml`, then start again.

**The health status reads `unhealthy`.** Run `curl http://localhost:3000/api/health`. An answer of `{"status":"unready", ...}` gives a reason, and `docker compose logs dezfil` shows the detail.

**The logs show "DEZFIL_SECRET_KEY must be 64 hex characters (32 bytes)."** The key in `.env` has another form, so nothing was encrypted with it. Replace its value with 64 hex characters: the key you kept, or a new one from `openssl rand -hex 32`. Then run `docker compose up -d`.

**Settings shows "The instance’s encryption key cannot read the saved address. Save it again."** The key changed after the address was saved. Put the earlier key back in `.env` and run `docker compose up -d`. If that key is lost, [Back up and restore](backup-and-restore.md#saved-connections-or-service-addresses-fail-after-a-restore) says what to save again.

## Next steps

- [Back up and restore](backup-and-restore.md): copy the `dezfil-data` volume, and keep `.env` apart from it.
- [Upgrade](upgrade.md): move to a new version and keep your data.
- [Reverse proxy and HTTPS](reverse-proxy.md): serve Dezfil under your domain.
- [Everyday commands](../start/install.md#everyday-commands): stop, start and read the logs.
- [Configuration](configuration.md): add other settings to `.env` or `compose.yaml`.
