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

Set these variables on the server and restart it. With no keys or audience, password sign-in stays enabled.

## Troubleshooting

A public key without an audience, or an audience without a public key, stops startup. Supply both and a sign-in service address.

## Next steps

- [Users](../users.md): invite people to your instance.
- [Security and rules](rules.md): choose session and token lifetimes.
