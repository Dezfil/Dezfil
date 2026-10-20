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

An admin sets these on the **Security**, **Publishing** and **Data & services** tabs of **Settings**. Each one has a Settings key and no variable.

<!-- settings-rules:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Stay signed in for** |  | `security.sessionDays` | `30` days | `1`, `7`, `30` or `90` | How long a session lasts after its last use. A session keeps the expiry it holds; its next use renews it by this length. | In Settings, live |
| **Invite and reset links last** |  | `security.linkDays` | `7` days | `1`, `3`, `7` or `14` | How long an invitation or a password reset link stays valid. A link keeps the lifetime it was issued with. | In Settings, live |
| **Failed sign-ins per account** |  | `security.failedPerAccount` | `5` per 15 minutes | A whole number from 3 to 100 | Failed sign-ins for one account, within a fixed 15 minutes, before its next attempt pauses. Wrong current passwords on password and email changes pause those changes at the same count, counted apart. Never above the count per address. | In Settings, live |
| **Failed sign-ins per address** |  | `security.failedPerAddress` | `20` per 15 minutes | A whole number from 10 to 1,000 | Failed sign-ins from one network address, within a fixed 15 minutes, before its next attempt pauses. Never below the count per account. | In Settings, live |
| **Shortest password** |  | `security.passwordMin` | `8` characters | A whole number from 8 to 64 | The fewest characters a password set from now may have. Passwords set earlier keep signing in. | In Settings, live |
| **Who may create tokens** |  | `tokens.create` | `everyone` | `everyone` or `admins` | Whether every account or only admins may create API tokens. Tokens made earlier keep working. | In Settings, live |
| **New tokens expire after** |  | `tokens.expiry` | `never` | `never`, `30d`, `90d` or `1y` | The lifetime a new API token takes, from its creation. Tokens made earlier keep their own. | In Settings, live |
| **Who may publish** |  | `publishing.publish` | `everyone` | `everyone`, `admins` or `none` | Whether every account, only admins or no one may publish a map or change a publication. Published maps stay public and can be unpublished. | In Settings, live |
| **Embedding on other sites** |  | `publishing.embedding` | `any` | `any`, `listed` or `off` | Which other sites may show a published page in a frame: any site, only the listed sites (at least one), or none. | In Settings, live |
| **Listed sites** |  | `publishing.embedSites` | none | Up to 50 sites, each `http` or `https` with a host and an optional port | The sites that may show a published page in a frame while embedding is limited to listed sites; never empty while it is. | In Settings, live |
| **Who may add database connections** |  | `connections.create` | `everyone` | `everyone` or `admins` | Whether every account or only admins may add a database connection. Connections made earlier keep working. | In Settings, live |
| **Who may import from links** |  | `imports.links` | `everyone` | `everyone` or `admins` | Whether every account or only admins may import from web addresses and cloud storage. Link datasets keep refreshing. | In Settings, live |

<!-- settings-rules:end -->

[Configuration](../configuration.md) shows how a change in Settings applies.
