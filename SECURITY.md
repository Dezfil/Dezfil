# Security policy

## Supported versions

Dezfil is at an early stage. Security fixes are made on the latest release
and on the default branch. Older releases are not patched.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## What Dezfil assumes about its environment

Read this before deciding whether something is a vulnerability.

Dezfil ships with **no authentication and no user accounts**. Anyone who can
reach the instance over the network can read, change and delete everything in
it, including uploaded data, saved maps and stored connection settings. This
is a deliberate property of the current design, not a defect. Run an instance
on a private network, behind your own authenticating proxy, or on a machine
only you can reach.

Reports that reduce to "an unauthenticated caller could do X" are therefore
expected behaviour. Reports that a caller can escape those boundaries are not,
and we want to hear about them. Examples of what we do consider a
vulnerability:

- reading or writing files outside the configured data directory;
- executing commands or code on the host through an upload, a query, or a
  connection setting;
- reaching a network address the egress allowlist should have blocked;
- leaking a stored credential, a secret key, or a connection password into a
  response, a log line, an exported file, or a published map;
- causing a published map to expose data that was not published.

## Reporting a vulnerability

Please report privately, not in a public issue.

Email **security@dezfil.io**. It reaches the maintainers and nobody else.

If you would rather stay on GitHub, use its private vulnerability reporting on
this repository instead: open the **Security** tab, choose **Report a
vulnerability**, and fill in the form. That report is also visible only to the
maintainers until it is resolved. Either route reaches us, so one is enough.

Include, as far as you can:

- what an attacker gains;
- the steps to reproduce it, with a minimal example;
- the version or commit you tested, and how the instance was configured;
- whether you have published anything about it anywhere.

## What to expect

- **Within 5 working days**: an acknowledgement that the report arrived.
- **Within 15 working days**: an assessment, saying whether we treat it as a
  vulnerability and roughly how severe we judge it.
- **Fix**: for an accepted report, a fix or a documented mitigation, released
  as soon as it is ready. We will tell you the plan and keep you updated if it
  takes longer.
- **Credit**: we will name you in the release notes and the advisory unless you
  ask us not to.

We ask for 90 days before public disclosure, or until a fix is released,
whichever comes first. If we go quiet, say so in the report thread; if we are
still quiet after another 15 working days, you are free to publish.

## Out of scope

- Missing authentication, as described above.
- Findings from an automated scanner with no demonstrated impact.
- Denial of service through sheer volume of requests or very large uploads.
- Vulnerabilities in a dependency with no path to exploit them through Dezfil.
  Report those upstream; tell us too, so we can pull the fix in.
