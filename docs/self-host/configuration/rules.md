---
title: "Security and rules"
summary: "Set how long sign-ins and links last, the shortest password, and who may create tokens, publish, embed, add connections and import."
read_when:
  - "you want people to stay signed in for a shorter or longer time"
  - "you want only admins to publish, create tokens, add connections or import from links"
  - "you want to limit which sites may embed a published map"
audience:
  - operator
  - agent
checked: none
order: 5
---

An admin sets these on the **Security**, **Publishing** and **Data & services** tabs of **Settings**. These rules have no variables of their own, and a change applies at once. The token lifetime takes a separate bound from **Limits**.

<!-- settings-rules:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Stay signed in for** |  | `security.sessionDays` | `30` days | `1`, `7`, `30` or `90` | How long a session lasts after its last use. A session keeps the expiry it holds; its next use renews it by this length. | In Settings, live |
| **Invite and reset links last** |  | `security.linkDays` | `7` days | `1`, `3`, `7` or `14` | How long an invitation or a password reset link stays valid. A link keeps the lifetime it was issued with. | In Settings, live |
| **Failed sign-ins before a pause** › **Per account** |  | `security.failedPerAccount` | `5` per 15 minutes | A whole number from 3 to 100 | Failed sign-ins for one account, within a fixed 15 minutes, before its next attempt pauses. Wrong current passwords on password and email changes pause those changes at the same count, counted apart. Never above the count per address. | In Settings, live |
| **Failed sign-ins before a pause** › **Per address** |  | `security.failedPerAddress` | `20` per 15 minutes | A whole number from 10 to 1,000 | Failed sign-ins from one network address, within a fixed 15 minutes, before its next attempt pauses. Never below the count per account. | In Settings, live |
| **Shortest password** |  | `security.passwordMin` | `8` characters | A whole number from 8 to 64 | The fewest characters a password set from now may have. Passwords set earlier keep signing in. | In Settings, live |
| **Who may create tokens** |  | `tokens.create` | `everyone` | `everyone` or `admins` | Whether every account or only admins may create API tokens. Tokens made earlier keep working. | In Settings, live |
| **New tokens expire after** |  | `tokens.expiry` | `never` | `never`, `30d`, `90d` or `1y` | The lifetime a new API token takes, from its creation. Tokens made earlier keep their own. | In Settings, live |
| **Who may publish** |  | `publishing.publish` | `everyone` | `everyone`, `admins` or `none` | Whether every account, only admins or no one may publish a map or change a publication. Published maps stay public and can be unpublished. | In Settings, live |
| **Embedding on other sites** |  | `publishing.embedding` | `any` | `any`, `listed` or `off` | Which other sites may show a published page in a frame: any site, only the listed sites (at least one), or none. | In Settings, live |
| **Embedding on other sites** › **Listed sites** |  | `publishing.embedSites` | none | Up to 50 sites, each `http` or `https` with a host and an optional port | The sites that may show a published page in a frame while embedding is limited to listed sites; never empty while it is. | In Settings, live |
| **Who may add database connections** |  | `connections.create` | `everyone` | `everyone` or `admins` | Whether every account or only admins may add a database connection. Connections made earlier keep working. | In Settings, live |
| **Who may import from links** |  | `imports.links` | `everyone` | `everyone` or `admins` | Whether every account or only admins may import from web addresses and cloud storage. Link datasets keep refreshing. | In Settings, live |

<!-- settings-rules:end -->

- A rule refuses new actions and takes nothing away. A refused action answers `403 rule_refused`, with `error.rule` naming the rule, and the screens show that action disabled.
- Every signed-in account and agent reads the rules it follows as `rules` in `GET /api/config`, with the shortest password as `passwordMin`.

## Token lifetimes

| **Longest token lifetime** on **Limits** | **New tokens expire after** offers |
|---|---|
| `none`, the default | `never`, `30d`, `90d`, `1y` |
| `30d` | `30d` |
| `90d` | `30d`, `90d` |
| `1y` | `30d`, `90d`, `1y` |

Set `tokenLifetimeMax` through the instance settings operation, or lock it with `DEZFIL_TOKEN_LIFETIME_MAX`. [Limits](../../api/limits.md#limits-an-operator-changes) lists its values and how to change it.

A stored `tokens.expiry` above the bound reads as the bound in `GET /api/config` rules and in the settings row's `value`. Its `storedValue` stays unchanged.

New tokens take that effective lifetime. Existing tokens keep their expiry, including tokens without one. Sign-in mode does not change the bound.

For clients, the settings row's `write.values` contains the offered choices. Submitting a choice above the resulting bound answers `400 invalid_request`; the whole settings change is refused.

Lowering the bound alone leaves the stored rule intact. Removing the bound makes that rule effective again.

## Sign everyone out

An admin can end every account's sessions and API tokens in either sign-in mode.

1. In **Settings**, under **Instance**, open **Security** and click **Sign everyone out**. You should see **Sign everyone out?** and what ends.
2. Click **Sign everyone out** again. You should see the sign-in page: your own session ended too.

Through the API:

```sh title="Terminal"
curl -s -X POST https://maps.example.com/api/instance/sign-out \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

```json title="Output"
{"signOutGeneration":1,"doorGeneration":0}
```

The numbers are the stored generations after the raise. Each call increases `signOutGeneration`; `doorGeneration` stays unchanged. Over MCP, `sign_everyone_out` requires confirmation and names the caller's credentials too.

Every session and token made before either generation rose loses access, including yours. Older assistant work is interrupted and parked runs end. Accounts, roles, memberships and identity bindings stay unchanged.

Sign in again and make new tokens. Old tokens answer `401 token_outdated`. An external ticket's higher door generation, or a raised startup floor, has the same effect on earlier credentials.

In [external sign-in mode](external-sign-in.md), session and token lifetimes still apply. Password and link settings stay stored but those sign-in methods are unavailable. Failed arrivals use the per-address allowance.

[Configuration](../configuration.md) shows how a change in Settings applies.
