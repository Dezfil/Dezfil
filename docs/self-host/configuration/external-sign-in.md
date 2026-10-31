---
title: "External sign-in"
summary: "Configure the public keys, instance identity and first owner for a trusted sign-in service."
read_when:
  - "you want a trusted service to sign people into your instance"
  - "you need the external sign-in variables and their formats"
audience:
  - operator
  - developer
checked: none
order: 7
---

<!-- settings-external-sign-in:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Sign-in public keys** | `DEZFIL_EXTERNAL_SIGN_IN_KEYS` |  | unset | Raw 32-byte Ed25519 public keys in unpadded base64url, separated by commas | Public keys trusted for external sign-in; reads disclose only the count. | By variable, after a restart |
| **Sign-in audience** | `DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE` |  | unset | The exact audience string tickets must name | This instance's identity, required in every sign-in ticket. | By variable, after a restart |
| **Sign-in service** | `DEZFIL_EXTERNAL_SIGN_IN_URL` |  | unset | An HTTP or HTTPS address without user information or a fragment | The address the browser visits to sign in. | By variable, after a restart |
| **First owner's identity** | `DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID` |  | unset | A non-empty stable identity string | Stable identity of the first admin, read only on an empty store. | By variable, after a restart |
| **First owner's email** | `DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL` |  | unset | An email address | Email of the first admin, read only on an empty store. | By variable, after a restart |
| **First owner's name** | `DEZFIL_EXTERNAL_SIGN_IN_OWNER_NAME` |  | unset | A display name | Optional name of the first admin, read only on an empty store. | By variable, after a restart |
| **Door generation floor** | `DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR` |  | `0` | A non-negative safe whole number | Minimum door generation, applied at start. Lowering it never lowers the stored generation. | By variable, after a restart |

<!-- settings-external-sign-in:end -->

## Enable external sign-in

Set both public keys and an audience, plus the door address. Dezfil trusts tickets from that service, called the door, to sign people in.

```yaml title="compose.yaml"
services:
  dezfil:
    environment:
      DEZFIL_EXTERNAL_SIGN_IN_KEYS: "<RAW_PUBLIC_KEY>"
      DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: "maps-production"
      DEZFIL_EXTERNAL_SIGN_IN_URL: "https://sign-in.example.com/dezfil"
      DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID: "<STABLE_OWNER_ID>"
      DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL: "owner@example.com"
      DEZFIL_EXTERNAL_SIGN_IN_OWNER_NAME: "Map owner"
      DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR: "0"
```

Replace the placeholders, then [replace the container](../configuration.md#set-a-variable). Configuration is read once at start. No public keys and no audience leaves password sign-in enabled.

| Value | How to choose it |
|---|---|
| Public keys | Raw 32-byte Ed25519 public keys, unpadded base64url, separated by commas. PEM and private keys are refused. The [door guide](../sign-in-service.md#make-a-signing-key) generates the format. |
| Audience | A distinct identity for this instance. Every ticket must name it exactly. |
| Door address | The browser's sign-in destination. Use HTTPS for a remotely served instance. No user information or fragment. Existing query parameters are preserved; `start` is replaced with the browser's random value. |
| First owner | The door's stable subject id and verified email. These are required only while the store has no account. The name is optional. |
| Generation floor | A non-negative whole number, at most 9,007,199,254,740,991. It can raise the stored door generation, never lower it. |

An empty instance reserves that owner as an invited admin bound to the configured id, without credentials. The first matching ticket activates it. The same email under another id cannot claim it.

On a store with accounts, the owner variables do nothing. An existing account without a bound identity binds on its first ticket with the same verified email.

## What changes

| Action | With external sign-in |
|---|---|
| Sign in | The sign-in page shows the message from **Settings** and **Continue to sign in**, with no fields and no lost-password line. |
| Invite by name and email | Creates an invited account with no link or credential. The person signs in at the door using that email, and their row on **Users** says so. |
| Create the first account, sign in with a password, redeem or issue a sign-in link, change a password | Refused with `403 external_sign_in_only`. Local recovery also refuses before opening the store. |
| Change your email | Refused with the same code, and **Email** is read-only on **Account**. The door supplies the verified email at arrival. Your name remains editable. |
| Use the API or MCP | Uses ordinary API tokens. Tickets never authenticate API or MCP calls. |
| Admin configuration read | `GET /api/instance/settings` reports the mode, key count and both generations, without key material. The deployment rows include the door address. **Settings** > **System** > **External sign-in** shows the same. |

The refusal reads: **This instance signs people in through its sign-in service. Passwords and sign-in links are unavailable.**

Stored passwords stay unchanged. To restore password sign-in, remove both keys and audience and restart. Raised generations remain in the store, so earlier invalidated credentials stay invalid.

## Rotate keys and raise generations

1. Add the new public key beside the old one and restart Dezfil.
2. Make the door sign with the new private key. Both public keys are accepted during the overlap.
3. Remove the old public key and restart after its tickets have expired.

Each restart ends starts in flight; people begin sign-in again. Public-key rotation alone does not end existing sessions or tokens.

To invalidate earlier credentials, raise the door generation floor and restart, or accept a ticket carrying a higher door generation. It is adopted before the new session is created.

The independent sign-out generation rises through the admin operation [Sign everyone out](rules.md#sign-everyone-out), in either mode. Neither generation changes accounts, roles, project memberships or bound identities.

## Troubleshooting

| Symptom | Check |
|---|---|
| Startup names a missing audience or public key | Supply both, or remove both to disable the mode. |
| Startup names the door address or key format | Use the formats in the table. |
| Startup names the first owner's id or email | An empty store needs both. Check that the intended data volume is mounted. |
| A ticket is invalid after restart | Click **Start again** on the page. Starts last ten minutes and do not survive restart. |
| The page says **You are already signed in** | The browser holds a session, which the ticket does not replace. Click **Sign out**, then sign in again, or **Stay signed in**. |
| A valid identity cannot enter | An admin must invite its verified email first. A deactivated account must be reactivated. Bound identities cannot be reassigned. |

## Next steps

- [Build a sign-in service](../sign-in-service.md): sign tickets and return the browser to Dezfil.
- [Users](../users.md): invite people to your instance.
- [Security and rules](rules.md): choose session and token lifetimes and sign everyone out.
