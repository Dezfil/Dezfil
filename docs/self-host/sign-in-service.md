---
title: "Build a sign-in service"
summary: "Generate an Ed25519 key, sign a browser-bound ticket and return the person to an instance that trusts your service."
read_when:
  - "you build a service that signs people into Dezfil"
  - "you need the ticket claims, signing format and browser return address"
audience:
  - developer
  - operator
  - agent
checked: none
order: 10
---

The sign-in service, called the door, authenticates a person and signs a short-lived ticket. Dezfil checks it locally and grants only that account's existing permissions.

| Step | Exchange |
|---|---|
| Start | The instance posts to `/api/auth/external/start` with its own `Origin`. It sets a ten-minute HttpOnly start cookie and redirects the browser to your configured door address with `?start=<VALUE>`. |
| Authenticate | The door signs in the person, verifies their email and keeps the supplied start value attached to that sign-in. |
| Return | The door redirects to the configured instance's `/arrive#ticket=<COMPACT_JWS>`. The fragment keeps the ticket out of the URL sent to the server. |
| Arrive | The arrival page posts `{"ticket":"<COMPACT_JWS>"}` to `/api/auth/external/arrive`, with the instance's `Origin` and browser cookie. Success returns the account and a session cookie; arrival clears the start cookie. |

Configure the instance address and audience on your door, alongside [Dezfil's configuration](configuration/external-sign-in.md). The start redirect supplies only the random start value, not a return address or permissions.

## Make a signing key

Save this file on the door's host and run it with Node.js 24 or newer:

```js title="make-door-key.mjs"
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync("door-private.pem", privateKey.export({ format: "pem", type: "pkcs8" }),
  { mode: 0o600, flag: "wx" });
console.log(publicKey.export({ format: "jwk" }).x);
```

```sh title="Terminal"
node make-door-key.mjs
```

Put the printed value in `DEZFIL_EXTERNAL_SIGN_IN_KEYS`. It is the raw 32-byte public key in unpadded base64url. Keep `door-private.pem` on the door; Dezfil needs no private key.

## Sign the ticket

Use compact JWS: three unpadded base64url segments for the UTF-8 JSON header, UTF-8 JSON payload and signature, joined with periods.

The header is `{"alg":"EdDSA"}`. Optional `"typ":"JWT"` is accepted; other header fields, including `kid`, are refused. Dezfil tries every configured public key.

| Claim | Required value |
|---|---|
| `aud` | The instance's exact audience string, not an array. |
| `sub` | Stable identity id, 1–256 characters. Never reuse it for another person. |
| `email` | The person's verified email, 1–320 characters. |
| `email_verified` | Boolean `true`. |
| `name` | Optional nonblank display name, at most 80 characters. |
| `iat` | Non-negative whole Unix seconds, at most 60 seconds ahead of the server clock. |
| `exp` | Whole Unix seconds, strictly after `iat`, at most `iat + 300`, and strictly after the server clock. No expiry grace. |
| `jti` | A unique ticket id, 1–256 characters, consumed once until expiry. |
| `start` | The exact start value received from the browser's redirect. |
| `door_generation` | Non-negative safe whole number, at least the instance's stored door generation. A higher accepted value raises it. |

Text claims reject control characters. The complete compact ticket is at most 6,144 characters; the JSON arrival body is at most 8,192 bytes. Extra claims grant no permissions.

This function belongs after your service has authenticated the person and verified their email. `person` comes from that trusted result, not from fields supplied by the browser.

```js title="door-ticket.mjs"
import { randomUUID, sign } from "node:crypto";

export function arrivalUrl(config, person, start) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    aud: config.audience,
    sub: person.id,
    email: person.email,
    email_verified: true,
    ...(person.name ? { name: person.name } : {}),
    iat,
    exp: iat + 300,
    jti: randomUUID(),
    start,
    door_generation: config.doorGeneration,
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "EdDSA" })}.${encode(payload)}`;
  const ticket = `${input}.${sign(null, Buffer.from(input), config.privateKey).toString("base64url")}`;
  const destination = new URL("/arrive", config.instanceUrl);
  destination.hash = new URLSearchParams({ ticket }).toString();
  return destination.href;
}
```

Supply `privateKey` as the contents of `door-private.pem`, plus the configured `instanceUrl`, `audience` and `doorGeneration`. Redirect the same browser to the returned address.

## Who may enter

| Account found | Result |
|---|---|
| Bound to `sub`, active or invited | Signs in and activates an invitation. A changed verified email is accepted unless another account holds it. |
| Same verified email, no bound identity | Binds that account to `sub`, then signs in. |
| Same email, bound to another identity | Refused. Accounts are never merged or rebound. |
| No account | Refused: **There is no account for &lt;email&gt; on this instance. Ask its admin for an invitation.** |
| Deactivated | Refused: **This account is deactivated. Contact an admin.** |

Names set by an admin stay. Only the first owner's absent configured name is filled from the ticket's name, falling back to its email. Deleting an account removes its identity binding.

## Refusals and retries

A browser with a valid session receives `409 already_signed_in`, with that account in `error.account`. Its session stays unchanged. Sign out before starting another sign-in.

An expired, foreign, altered or reused ticket answers `401 invalid_ticket`. So does a missing or expired start, or a start from before a restart. Begin again from the instance.

Accepted ticket ids survive restart in the data directory. Refusals charge the source address's failed-sign-in budget; repeated failures reach `429 rate_limited` with `Retry-After`, `retryAfter` and `retryAt`.

A higher door generation ends older sessions, tokens and their delegations and interrupts older assistant work, parked runs included. The arriving session carries the new generation and works.

The door generation and the admin's sign-out generation rise independently. A raise changes no account, role, membership or identity binding. After a restore, set the generation floor appropriate to your deployment before starting it.

## Next steps

- [External sign-in configuration](configuration/external-sign-in.md): enable the mode, rotate keys and raise its floor.
- [Errors](../api/errors.md): handle coded refusals.
- [What leaves the instance](what-leaves-the-instance.md): understand the browser redirect and local signature check.
