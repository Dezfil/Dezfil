---
title: "Users"
summary: "Add people to your instance, make someone an admin, reset a forgotten password, and get back in when no admin can sign in."
read_when:
  - "you want to give someone an account on your Dezfil"
  - "you want to make someone an admin, or take admin access away"
  - "someone forgot their password, or their sign-in link stopped working"
  - "you want to close an account, or delete it with its work"
  - "you lost the admin password and no other admin can sign in"
audience:
  - operator
checked: none
order: 7
---

![The Users page: the Invite button, the search box, and the list of people with their email, role, status and last sign-in, one of them under Deactivated](../images/self-host/users-list.webp)

Admins manage every account on the **Users** page, in the side menu; members do not see it. An admin adds each person; the first account comes from setup or the configured external owner.

| To | Do this on **Users** |
|---|---|
| Add a person | Click **Invite** |
| Make someone an admin | Open their row and click **Make admin** |
| Reset a forgotten password | Open their row and click **Reset password** |
| Take away someone's picture | Open their row and click **Remove picture** |
| Close an account and keep its work | Open their row and click **Deactivate** |
| Delete an account and its work | Deactivate it, then click **Delete account** |
| Get in when no admin can sign in | Run the [recovery script](#recover-the-admin-account) on the server |

## Add a person

| Mode | Invitation and recovery |
|---|---|
| Password | Follow the steps below. |
| [External sign-in](configuration/external-sign-in.md) | Invite by verified email. The account gets no link or credential: its row says **They sign in at the sign-in service with ana@example.org. There is no link to send.** Its first ticket activates it and makes it available in the sharing directory. Rows offer no **Reset password**, **New sign-in link** or **Change password**. Password changes, links and local recovery are refused with `external_sign_in_only`. |

1. On **Users**, click **Invite**. A row opens at the top of the list, with **Name** and **Email** fields.
2. Type the person's name and email address. To make them an admin from the start, tick **Admin**.
3. Click **Create account**. You should see **Account created for Ana Diaz**, and the row opens on the **Sign-in link**.
4. Click **Copy link**. You should see **Copied** on the button.
5. Send the link to the person yourself, by chat or email, then click **Done**.

The link shows once; Dezfil sends no email. **Status** stays **Invited** until the person uses it.

They open the link, choose a password and click **Set password**. Dezfil signs them in as **Active**.

The line under the field names the shortest password, and very common passwords are refused. A link lasts 7 days by default, and each keeps the lifetime it was made with. [Security and rules](configuration/rules.md) lists both settings.

> [!NOTE]
> The link starts with the address you opened Dezfil at. Invite people while you use the address they will use, such as `https://maps.example.com`, not `http://localhost:3000`.

## Make someone an admin

1. Click the person's row to open it.
2. Click **Make admin**. You should see **Ana Diaz: admin access granted**, and **Admin** in the **Role** column.

**Remove admin** returns the account to **Member**.

| An admin | A member |
|---|---|
| Opens **Users** and manages every account | Does not see **Users** |
| Changes the instance in the **Instance** tabs of **Settings** | Sees only **General** under **Instance**, and cannot change it |
| Publishes maps, makes API tokens, adds database connections and imports from links when a rule says **Admins only** | Sees a line such as **Only admins can publish maps on this instance.** |

Each account's maps, workflows and datasets are private, including from admins, until a project's owner shares the project. An admin reaches them as anyone does, through a project shared with them, as [Share and publish](../use/share-and-publish.md) describes.

In password mode your own row offers **Change password**: you cannot remove your own admin access or deactivate yourself. Another admin does that, and Dezfil always keeps at least one active admin.

## Reset a password

These steps apply in password mode.

1. Open the person's row and click **Reset password**. You should see **The current password, earlier links and browser sessions stop working, and any AI key of theirs is removed.** Using the link ends API tokens and assistant work too.
2. Click **Reset password** again to confirm. You should see the **Sign-in link** and when it expires.
3. Click **Copy link**, send the link to the person, then click **Done**.

They open the link and choose a new password, as a new person does. For someone who has not used their invitation, the button reads **New sign-in link**. A new link replaces every earlier one.

The sign-in page tells people who forgot their password: **Forgot your password? An admin can reset it.** To name someone else, such as your GIS team, type it in **Settings** > **General** > **Lost password contact** and click **Save**.

To change your own password, see [Your settings](../use/settings.md#change-your-password).

## Remove someone's picture

1. Open the person's row and click **Remove picture**. You should see **Ana Diaz: picture removed**, and their initials.

The button shows while the person has a picture, active or deactivated. Only they can set a new one, in [Your settings](../use/settings.md#set-your-picture).

## Deactivate or delete an account

To close an account and keep its work:

1. Open the person's row and click **Deactivate**. You should see **Browser sessions will end and API tokens will lose access. Their work stays here.**
2. Click **Deactivate** again. You should see **Ana Diaz: deactivated**, and the row under **Deactivated · 1**.

The person cannot sign in. Their picture stays, dimmed beside their name. Their maps, workflows, datasets and projects stay where they are: people who reach them can open them and copy a map or workflow, but nobody can change them. Their published maps stay public.

To undo it, open the row and click **Reactivate**. Everything returns to the same person.

To take one offline and keep the account, an admin revokes its link through the API: `DELETE /api/publications/<PUBLISH_TOKEN>` with an admin's token, where `<PUBLISH_TOKEN>` ends the map's link, after `/v/`. It answers 204 with no body, and the link stops working at once. An active owner's link answers 404 and stays. The [operation reference](https://dezfil.io/docs/api/reference/publish/#delete-api-publications-token) shows the call.

To delete an account with everything it owns:

1. Deactivate the account first. An invitation nobody used can be deleted at once.
2. Open the row and click **Delete account**. The dialog counts what goes with it: maps, datasets, workflows, projects, connections and published links, and the people who lose access.
3. Type the account's email in the box, where the dialog asks for it, and click **Delete account**. You should see **Ana Diaz: deleted**. An account that owns much may first show **Deleting**, then leave the list.

> [!WARNING]
> Deleting cannot be undone. It removes everything the account owns, wherever it is filed, and takes its published maps offline. To keep someone's work for the team, leave the account deactivated.

Its projects close: work other people filed in them stays theirs, in no project. Other people's maps and workflows that read its datasets lose those inputs.

Changes the account made to other people's maps and workflows then show **Deleted account** as their author. Deleting also empties the caches of the address finder, travel time and OpenStreetMap.

Deleting reaches nothing outside the instance: backups, downloaded files, the server's logs, the assistant's provider and databases a connection wrote to keep their copies.

To finish a deletion, Dezfil rewrites its metadata database, and answers no request until that ends, health checks included. The pause grows with the database, and a slow disk makes it longer. It needs free space of the database's size twice: in the volume, and in the container's temporary files on Docker's own disk.

## Recover the admin account

Run the script with the instance's deployment environment. External mode refuses it before opening the store, and refuses every recovery link at redemption.

In password mode, if no admin can sign in, run the recovery script on the server. It prints a one-time link with which an admin account chooses a new password.

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker exec -it dezfil node scripts/admin-recover.mjs \
  --data-dir /data --origin <YOUR_DEZFIL_ADDRESS> --email <ADMIN_EMAIL>
```

If the container is stopped, run the script in a one-off container on the same volume:

```sh title="Terminal"
docker run --rm -it -v dezfil-data:/data ghcr.io/dezfil/dezfil \
  node scripts/admin-recover.mjs --data-dir /data --origin <YOUR_DEZFIL_ADDRESS> --email <ADMIN_EMAIL>
```

:::

:::tab[Docker Compose]

Run this in the folder that holds your `compose.yaml`:

```sh title="Terminal"
docker compose exec dezfil node scripts/admin-recover.mjs \
  --data-dir /data --origin <YOUR_DEZFIL_ADDRESS> --email <ADMIN_EMAIL>
```

If Dezfil is stopped, run the Docker tab's one-off command: it uses the same volume and image.

:::

:::tab[From source]

Run this in your checkout:

```sh title="Terminal"
npm run admin:recover -- \
  --data-dir ./data --origin <YOUR_DEZFIL_ADDRESS> --email <ADMIN_EMAIL>
```

If you set `DEZFIL_DATA_DIR`, give `--data-dir` that folder instead.

:::

::::

- `-it` gives the script your terminal. Without one it refuses to run, so the link never lands in a pipe or a log. `docker compose exec` gives one by itself.
- `--data-dir` is the folder that holds the instance's data: `/data` in the container.
- `--origin` is the address people open Dezfil at, such as `https://maps.example.com` or `http://localhost:3000`, with no path. The link starts with it.
- `--email` picks the admin account. When the instance has exactly one active admin, you can leave it out.

```text title="Output"
Account: "admin@example.com"
Expires: 2026-10-20T14:15:00.000Z
https://maps.example.com/accept#secret=<SECRET>
```

1. Open the link within 15 minutes; the expiry is in UTC. You should see **Choose your password**.
2. Type a new **Password** and click **Set password**. You should see **Home**, or the landing page your instance opens on, signed in as that admin.

The script works with the server running or stopped, and a second run replaces the link. It ends that account's old password, earlier links, browser sessions and API tokens, so make new tokens in **Settings** > **API & MCP**. Other accounts keep theirs.

> [!NOTE]
> If someone else took over the instance, the script lets you back in but leaves their accounts and changes in place. Restore a backup from before, as [Back up and restore](backup-and-restore.md) describes.

## Troubleshooting

### The person sees "This sign-in link is unavailable."

The link expired, was used, or was replaced by a newer one, or the account is deactivated. Open their row, click **New sign-in link** or **Reset password**, and send the new link. A deactivated account needs **Reactivate** first.

### Creating an account says "This account is deactivated. Reactivate it in Users."

That email belongs to a deactivated account. Click **Reactivate existing account** under the message to open it again, with its work.

### Creating an account says "An account already uses this email address."

The person has an account already. Type their email in **Search users…** to find it.

### A row says "Deletion unfinished"

Dezfil could not delete everything yet, for example for want of disk space. The account stays closed: nobody can sign in to it or open its work. Free the space, then open the row and click **Finish deleting**. It is safe to repeat, also after a restart, so never edit the database or remove its files by hand.

A program outside Dezfil that keeps the database open, such as a replication tool, also stops a deletion from finishing. Stop it first.

### Copy link says "The link could not be copied. Select it and copy it manually."

Copying needs HTTPS or `localhost`. Otherwise, select the link and copy it with your keyboard. [Reverse proxy and HTTPS](reverse-proxy.md) serves Dezfil over HTTPS.

### The recovery script stops with a message

Nothing changes when the script stops. Find the start of its message:

| The script says | Fix |
|---|---|
| "This instance signs people in through its sign-in service. Passwords and sign-in links are unavailable." | Recover access through the sign-in service. |
| "Run admin recovery in a terminal." | It had no terminal to print to. Add `-it` to `docker exec` or `docker run`. With Docker Compose, leave out `-T`. |
| "Several active admins exist. Select one with --email." | Add `--email` with the email of the admin account you want back. |
| "That email does not identify an active admin." | Check the spelling. The account must be an admin and active, and the script cannot change either: it never makes an admin, reactivates an account or sets up an instance. Another admin who can sign in does it on **Users**. |
| "Supply an explicit reachable HTTP/HTTPS instance origin" | Give `--origin` the address alone, starting with `http://` or `https://`, such as `https://maps.example.com`: no path, no query, no user name. |
| "No setup-complete store found." | `--data-dir` names a folder without the instance's data, `-v` names another volume than your instance's, or setup never finished. In the container, the folder is `/data`, and `docker volume ls` lists the volumes. On a new instance, open Dezfil and create the first account. |
| "Incompatible metadata store." | The script comes from another Dezfil version than the data, or it cannot write the data. Run it in the instance's own container, or with the image that last ran on the volume, without `:ro` on the volume. From source, run it as the user that runs Dezfil. |
| "The metadata store stayed busy for five seconds." | Another process was writing to the data. Wait a moment and run the script again. |

## Next steps

- Share work with the people you added: [Share and publish](../use/share-and-publish.md).
- Change how long people stay signed in, and the other sign-in rules: [Security and rules](configuration/rules.md).
- Keep a copy of the data, accounts included: [Back up and restore](backup-and-restore.md).
- Manage accounts from a script: [How the API works](../api/http-api.md).
