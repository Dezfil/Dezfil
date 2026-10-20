---
title: "Reverse proxy and HTTPS"
summary: "Serve Dezfil at your own domain over HTTPS, with a reverse proxy in front of it."
read_when:
  - "you need to know what to set DEZFIL_TRUSTED_PROXIES to"
audience:
  - operator
checked: none
order: 2
---

## Trusted proxies

Set `DEZFIL_TRUSTED_PROXIES` to the address Dezfil sees your proxy's requests arrive from. Dezfil reads a visitor's address and scheme from forwarding headers only on a connection from an address it lists.

<!-- settings-proxies:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Trusted proxies** | `DEZFIL_TRUSTED_PROXIES` |  | unset | IP addresses or CIDR networks, separated by commas or spaces; a host name stops the server at start | Socket peers allowed to supply forwarding information. | By variable, after a restart |
| **Session cookie name** | `DEZFIL_SESSION_COOKIE` |  | port-based | ASCII letters, digits and ``!#$%&'*+-.^_`\|~``; any other value stops the server at start | Browser session cookie name, derived from the listening port unless overridden. | By variable, after a restart |

<!-- settings-proxies:end -->

[Configuration](configuration.md) shows how to set a variable.
