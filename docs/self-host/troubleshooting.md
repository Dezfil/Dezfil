---
title: "Troubleshooting"
summary: "Find the symptom your instance shows, from a container that stops at start-up to a refused upload, and fix it."
read_when:
  - "the container stops right after it starts, or health answers unready"
  - "sign-in fails behind your reverse proxy, or your domain sends the browser to another address"
  - "an upload is refused as too large, or ends with the connection dropped"
  - "the assistant does not answer, or map cards show no pictures"
  - "you forgot the admin password"
audience:
  - operator
checked: none
order: 9
---

Start with three checks. They show whether the container runs, what Dezfil wrote to its log, and whether it is ready to serve.

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker ps -a --filter name=dezfil
docker logs --tail 50 dezfil
curl http://localhost:3000/api/health
```

:::

:::tab[Docker Compose]

Run these in the folder that holds your `compose.yaml`.

```sh title="Terminal"
docker compose ps -a
docker compose logs --tail 50
curl http://localhost:3000/api/health
```

:::

::::

- The first command shows the container's state: `Up` while it runs, `Exited (1)` after an error.
- The second shows the last 50 lines of the log. An error at start-up is near the end.
- The third asks Dezfil whether it can serve.

```json title="Output"
{"status":"ready"}
```

As an admin, also open **Settings** > **System**. The **Status** card shows the **Data folder**, **Query engine**, **Tile builder**, **Image renderer** and **Metadata database**, and each row's **Test** button checks that part on the spot.

## Start-up

### The container stops right after it starts

`docker ps -a` shows `Exited (1)`, or Compose restarts the container over and over. The end of the log names the cause:

| The log says | Fix |
|---|---|
| `Data directory /data is not writable` | The files in the volume belong to another user, often after a restore. Give them to `node`, the user Dezfil runs as, as [Back up and restore](backup-and-restore.md#dezfil-stops-after-a-restore-and-its-log-says-data-directory-data-is-not-writable) shows. |
| `Data directory <PATH> cannot be created` | `DEZFIL_DATA_DIR` names a folder the container cannot create. Remove the variable and replace the container: the image keeps its data in `/data`. |
| `DEZFIL_SESSION_COOKIE must be a non-empty cookie-name token` | Use only letters, digits, `-` and `_` in the name, or remove the variable. Then replace the container. |
| `Invalid trusted proxy network` or `Invalid ingress address` | `DEZFIL_TRUSTED_PROXIES` takes IP addresses and CIDR ranges, separated by commas. A host name is refused. Then replace the container. |
| Any other line, right after an upgrade | Go back to the old version as [Upgrade](upgrade.md#go-back-to-the-old-version) describes, and keep the line for a bug report. |

### "port is already allocated" or "address already in use"

`docker run` or `docker compose up` stops with one of these messages. Another container or program holds port 3000 on this machine.

Serve Dezfil on another port: change the first `3000` in `-p 127.0.0.1:3000:3000`, or under `ports:` in `compose.yaml`, and open that port. `docker ps` lists which containers hold which ports.

### "The container name "/dezfil" is already in use"

`docker run` or `docker compose up` refuses because a container called `dezfil` exists, often a stopped one. Run `docker rm -f dezfil`, then your command again. The volume keeps your data.

### Dezfil asks you to create the first account again

The container runs on an empty volume, not the one that holds your data. Do not create an account: the first one becomes the admin.

[Back up and restore](backup-and-restore.md#dezfil-shows-create-the-first-account-after-a-restore-or-a-move) shows how to check which volume the container uses and start it on yours.

### Health answers "unready"

```json title="Output"
{"status":"unready","reason":"An unexpected server error occurred."}
```

Dezfil cannot write to its data folder, or it runs without its own start command. The log line after `[health] readiness unavailable:` says which. Free disk space or fix the mount. Otherwise remove any command you gave the container: `command:` in Compose, or words after the image name in `docker run`.

```json title="Output"
{"status":"unready","reason":"The query engine that runs SQL is not answering."}
```

The engine that runs SQL failed to start. The log line after `[health] query engine unavailable:` gives its error. Each health check starts it again, at most every 30 seconds, so health reads `ready` once the cause is gone.

### A variable has no effect

Open **Settings** > **System** and find the variable in **Server settings**. **Environment** under **Source** means the server took it. Any other source means it did not: a container keeps the variables it was created with, so [replace the container](configuration.md#set-a-variable).

**Default** also shows for a value Dezfil cannot use. The setting's row on its own tab, such as **Limits**, then reads "`<VARIABLE>` in the server's environment is not valid, so the default is used." A number takes digits alone, such as `10240`, in the unit the name ends with.

## Sign-in and the reverse proxy

### Sign-in says "This request must come from the same instance."

Dezfil sees another address than your browser, most often `http` where the browser has `https`. It reads the proxy's headers only from an address in `DEZFIL_TRUSTED_PROXIES`.

Set the variable to the address [Trust the proxy](reverse-proxy.md#2-trust-the-proxy) prints, and check that the proxy sends `X-Forwarded-Proto`. Replace the container and sign in again. You should see **Home**.

### Your domain sends the browser to `127.0.0.1:3000`

Dezfil builds its redirects and the sign-in links **Users** hands out from the host it receives. nginx sends its own upstream address unless told otherwise.

Make the proxy pass the visitor's host, as in [Set up the proxy](reverse-proxy.md#1-set-up-the-proxy), and trust the proxy. A link you made while you opened Dezfil at another address, such as `http://localhost:3000` over SSH, carries that address: make it again from your domain.

### Pages show "Invalid request provenance."

Every page answers with this error, as JSON. A trusted proxy sent forwarding headers that disagree, such as `Forwarded` beside different `X-Forwarded-*` values, or an `X-Forwarded-Port` that differs from the port the host names.

Let one proxy set the `X-Forwarded-*` headers and drop `Forwarded`, as [Reverse proxy and HTTPS](reverse-proxy.md#troubleshooting) shows.

### Pages say "The instance cannot accept sign-ins yet."

Dezfil runs without its own start command, which every request needs. Remove any `command:` you set for the service in Compose, or anything after the image name in `docker run`, and replace the container.

### Sign-in says "Too many sign-in attempts. Try again at …"

Sign-in pauses after too many failures within 15 minutes, for one account or from one address. Behind a proxy Dezfil does not trust, every visitor shares the proxy's address.

Wait until the time shown, and trust the proxy. To allow more failures, raise the **per address** or **per account** number of **Failed sign-ins before a pause** in **Settings** > **Security**.

### Published maps say "Too many requests"

A layer of a published map reads "unavailable: Too many requests. Retry after the indicated delay." Each visitor's address has its own budget, and behind an untrusted proxy all visitors share one.

Trust the proxy, or raise **Requests per visitor** and **Tile requests per visitor** in **Settings** > **Limits**.

### Signing in to one instance signs you out of another

Two containers on one machine, opened as `localhost` on different ports, use the same session cookie name. Each sign-in replaces the other's cookie.

Give one of them its own name, such as `-e DEZFIL_SESSION_COOKIE=dezfil_session_b`, and replace that container. A new name signs everyone out of that instance once, so tell its people to sign in again.

## Uploads and imports

### An upload says "Upload exceeds the size cap of … MB."

The file is larger than **Largest upload**. Raise it in **Settings** > **Limits**, on the **Imports** card. If the row is locked, change `DEZFIL_UPLOAD_MAX_MB` instead and replace the container.

A link import says "The remote file exceeds the cap of … MB." instead: raise **Largest link import** the same way. [Limits](../api/limits.md) gives both ranges.

### An upload ends with "The connection dropped. The file may still have imported."

Something between the browser and Dezfil cut the upload, most often the proxy. nginx refuses any request over 1 MB unless its `client_max_body_size` allows more.

Look on the **Data** page first: the file may have arrived. Then raise the proxy's limit as [Reverse proxy and HTTPS](reverse-proxy.md#uploads-over-1-mb-fail-behind-nginx) shows. Imports and queries that fail after a minute behind nginx need its [read timeout](reverse-proxy.md#long-imports-or-queries-fail-after-a-minute-behind-nginx) raised.

### "The requested address is not reachable from this server"

A PostGIS connection, a link import or a service address points at a private network, which Dezfil refuses by default. Inside the container, `localhost` is the container itself, not your machine.

List the host or its range in `DEZFIL_EGRESS_ALLOWLIST` and replace the container. [What leaves the instance](what-leaves-the-instance.md#private-addresses) shows how.

### A query or an import stops at its memory or time limit

| The message ends with | Change |
|---|---|
| `Narrow it down, or raise DEZFIL_QUERY_MEMORY_MB.` | `DEZFIL_QUERY_MEMORY_MB`: the memory that queries and tools share |
| `Reduce the work, or raise DEZFIL_TRUSTED_MEMORY_MB and restart.` | `DEZFIL_TRUSTED_MEMORY_MB`: the memory for imports and other data work |
| `An admin can change "Query time limit".` | **Query time limit** in **Settings** > **Limits** |

Both memory budgets come out of the machine's memory, so leave the container room for both. [Limits](../api/limits.md) lists every limit with its setting.

## The assistant and map pictures

### The assistant pane says "No model credential is configured."

The server has no provider key. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and replace the container. On the **Assistant** card of **Settings** > **System**, **Status** then reads **On**.

For a key the provider refuses, or a provider the server cannot reach, see [Set up the assistant](assistant.md#troubleshooting).

### Map cards show no pictures

Admins see "No map pictures: this instance has no renderer." above the cards. In **Settings** > **System**, click **Test** on the **Image renderer** row:

| The row says | Fix |
|---|---|
| **Not found**, and the test says "The image renderer's browser is not where its setting points." | `DEZFIL_CHROMIUM_PATH` names a file that is not there. In the container, remove the variable: the image brings Chromium at `/usr/bin/chromium`. |
| **Could not start** | Chromium is there, but its launch failed. If you set `DEZFIL_CHROMIUM_PATH`, check that it names a Chromium browser. |

After a fix, replace the container: Dezfil looks for the renderer as it starts, then once an hour. Image exports through the API or the assistant fail with "The image renderer's browser is not available on this instance." for the same reasons.

## Accounts and keys

### You forgot the admin password

If no other admin can sign in, run the recovery script on the server. It prints a one-time link, valid for 15 minutes, with which the admin chooses a new password.

[Recover the admin account](users.md#recover-the-admin-account) gives the command for Docker, Docker Compose and a checkout, and what each of the script's messages means.

### A link says "This sign-in link is unavailable."

The link expired, was used, or was replaced by a newer one. An admin makes a new one on **Users**, as [Users](users.md#the-person-sees-this-sign-in-link-is-unavailable) shows. For a recovery link, run the script again.

### Saved addresses say "The instance’s encryption key cannot read the saved address. Save it again."

Dezfil runs with another encryption key than the one that saved them, often after a restore or a move. Saved PostGIS connections fail for the same reason.

[Back up and restore](backup-and-restore.md#saved-connections-or-service-addresses-fail-after-a-restore) says which key to put back, and what to save again when it is lost.

### The log says "DEZFIL_SECRET_KEY must be 64 hex characters (32 bytes)."

The key you set has another form, so Dezfil encrypted nothing with it. [Docker Compose](docker-compose.md#troubleshooting) shows how to replace it.

## Next steps

- [Configuration](configuration.md): how a setting reaches the server, and where to see the value in effect.
- [Reverse proxy and HTTPS](reverse-proxy.md): serve Dezfil at your own domain.
- [Back up and restore](backup-and-restore.md): keep the data folder and its key safe.
- [Users](users.md): add people, and get back in when no admin can sign in.
