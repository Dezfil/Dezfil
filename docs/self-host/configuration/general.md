---
title: "General"
summary: "Name the instance, write the sign-in page's message and lost-password contact, and choose where people land after they sign in."
read_when:
  - "you want to give the instance a name or a sign-in message"
  - "you want to tell people whom to ask when they lose their password"
  - "you want people to land on another page after they sign in"
audience:
  - operator
  - agent
checked: none
order: 1
---

An admin sets these on the **General** tab of **Settings**. They have no variables, so nothing locks them, and a change applies at once.

<!-- settings-general:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Instance name** |  | `instanceName` | unset | Text, up to 80 characters | Name beside the wordmark and in browser titles. | In Settings, live |
| **Sign-in message** |  | `signInMessage` | empty | Text, up to 280 characters | Optional message on the sign-in page. | In Settings, live |
| **Lost-password contact** |  | `lostPasswordContact` | empty | Text, up to 120 characters | Contact line for password recovery; empty uses the built-in line. | In Settings, live |
| **Landing page** |  | `landingPage` | `home` | `home`, `projects`, `maps`, `workflows`, `data` or `sql` | Preferred entry destination after sign-in. | In Settings, live |

<!-- settings-general:end -->

The sign-in page shows the message as plain text, and names the contact in its lost-password line. [Configuration](../configuration.md) shows how a change in Settings applies.
