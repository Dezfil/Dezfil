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

Turn the quick start into an instance that lasts: its keys in a file of their own, a health check Docker reads, logs that stay small, and a start after every reboot.

- **You need:** Docker with the `docker compose` command, on the machine that serves Dezfil.
- **The code:** the `Dezfil` folder from [Install](../start/install.md). On a new machine, run `git clone https://github.com/Dezfil/Dezfil.git`.
- **For the key:** `openssl`, which makes a random encryption key.

## 1. Note what your instance runs with

On a new machine, go on with step 2. If Dezfil already runs here, note its key and its variables before you replace anything:

1. Sign in as an admin, open **Settings** > **System**, and find the **Encryption key** row in **Server settings**.
2. List the container's variables:

```sh title="Terminal"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' dezfil
```

The list holds the image's own variables too, such as `PATH` and `DEZFIL_DATA_DIR`. The others are the ones you set, with `-e` or under `environment:`.

The **Encryption key** row says which key to use in step 3:

- **secret.key in the data folder**: the volume's key, which [Keep the key you have](#keep-the-key-you-have) prints.
- **Set**, with the source **Environment**: the `DEZFIL_SECRET_KEY` value in the list.
- **Not created yet**: a new one, as step 3 makes it.

## 2. Write the Compose file

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
- `env_file: .env` passes the variables you write in step 3 to Dezfil.
- `restart: unless-stopped` starts Dezfil again after a crash and whenever Docker starts, unless you stopped it with `docker compose stop`.
- `healthcheck` asks `/api/health` from inside the container every 30 seconds. After three failures in a row, Docker marks the container unhealthy, but it does not restart it for that.
- `logging` caps the container's logs at three files of 10 MB each, so a long-running instance does not fill the disk.

If you used the Compose tab of Install, replace its `compose.yaml` with this one. Both use the `dezfil-data` volume, so your data stays.

## 3. Make the keys file

If step 1 gave you a key, write it into `.env` as the line `DEZFIL_SECRET_KEY=<64_HEX_CHARACTERS>` and run `chmod 600 .env`, in place of the commands below. Otherwise make a new key:

```sh title="Terminal"
printf 'DEZFIL_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

- `DEZFIL_SECRET_KEY` encrypts the passwords of saved database connections and the service addresses an admin saves in **Settings**. It takes 64 hex characters.
- `openssl rand -hex 32` makes a random key of that length.
- `chmod 600 .env` lets only your user read the file. Git ignores `.env`, and Docker leaves it out of the image it builds.

With a new key in `.env` from the first start, a copy of the volume alone cannot read those passwords.

Add the other variables you noted in step 1, one `NAME=value` line each, or put them under `environment:` in `compose.yaml` as [Configuration](configuration.md#set-a-variable) shows. To turn on the assistant, add its key to `.env`:

```sh title=".env"
DEZFIL_SECRET_KEY=<64_HEX_CHARACTERS>
ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_KEY>
```

For OpenAI, the line is `OPENAI_API_KEY=<YOUR_OPENAI_KEY>`. [Set up the assistant](assistant.md) covers the models and how to check that it answers.

When you change `.env` later, run `docker compose up -d`. Compose replaces the container and keeps the volume.

> [!WARNING]
> Keep a copy of `.env` in a safe place, apart from the volume's backups. Without its key, Dezfil cannot read the saved connection passwords and service addresses: you save each address again, and delete and add each connection again.

## 4. Start Dezfil

```sh title="Terminal"
docker compose up -d --build
```

The first build takes a few minutes.

If Dezfil runs from Install's Docker command, Compose stops at `The container name "/dezfil" is already in use`. Remove that container with `docker rm -f dezfil`, which keeps the volume, and run the command again. Compose then says the `dezfil-data` volume "already exists but was not created by Docker Compose", and uses it all the same.

About a minute after Dezfil starts, check its health:

```sh title="Terminal"
docker inspect --format '{{.State.Health.Status}}' dezfil
```

```text title="Output"
healthy
```

`starting` means the first check has not passed yet. Ask again after 30 seconds.

Then open <http://localhost:3000>. On a new volume, Dezfil asks for the first account, which becomes the admin: see [First run](../start/install.md#first-run). Behind a reverse proxy, the proxy's address changes with Compose: set `DEZFIL_TRUSTED_PROXIES` again as [Trust the proxy](reverse-proxy.md#2-trust-the-proxy) shows.

## 5. Check the keys

1. Sign in as an admin and open **Settings** > **System**.
2. In **Server settings**, find the **Encryption key** row. You should see **Set**, with the source **Environment**.
3. If you added an assistant key, the **Anthropic credential** or **OpenAI credential** row shows **Set** too.

**Set** shows that the variable reached Dezfil. A key of the wrong form also shows **Set**: [Troubleshooting](#troubleshooting) says how it shows itself.

## 6. Check the restart policy

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

Use that value in step 3. The volume keeps its `secret.key`, so its backups still hold that key. If you see `cat: /data/secret.key: No such file or directory` instead, the volume holds no key: read the **Encryption key** row again, as step 1 says.

## Troubleshooting

### Compose says "env file … not found"

Make the keys file of step 3 in the folder that holds `compose.yaml`, then start again.

### The health status reads `unhealthy`

Run `curl http://localhost:3000/api/health`. `Internal Server Error` means Dezfil did not start: [Start-up](troubleshooting.md#start-up) names the causes. An answer of `{"status":"unready", ...}` gives a reason, which [Health answers "unready"](troubleshooting.md#health-answers-unready) explains.

### Settings says "The instance’s encryption key cannot read the saved address. Save it again."

The key in `.env` is not the one that saved the address: it changed, or it has another form than 64 hex characters. With a key of another form, saving the address again fails with "An unexpected server error occurred.", and the logs say "DEZFIL_SECRET_KEY must be 64 hex characters (32 bytes)."

Put the earlier key back in `.env`, the value you kept or the volume's `secret.key`, then run `docker compose up -d`. A new key from `openssl rand -hex 32` is right only when Dezfil never saved anything with a key. If the earlier key is lost, [Back up and restore](backup-and-restore.md#saved-connections-or-service-addresses-fail-after-a-restore) says what to save again.

## Next steps

- [Back up and restore](backup-and-restore.md): copy the `dezfil-data` volume, and keep `.env` apart from it.
- [Upgrade](upgrade.md): move to a new version and keep your data.
- [Reverse proxy and HTTPS](reverse-proxy.md): serve Dezfil under your domain.
- [Everyday commands](../start/install.md#everyday-commands): stop, start and read the logs.
- [Configuration](configuration.md): add other settings to `.env` or `compose.yaml`.
