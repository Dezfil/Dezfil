# Contributing to Dezfil

Thanks for taking an interest. This file is everything you need to get a
change from your machine into the project.

## Before you write code

For anything larger than a typo, **open an issue first** and say what you want
to change and why. Dezfil has a deliberately narrow scope right now, and a
short conversation before you start is much cheaper than a rejected pull
request afterwards.

Security problems do not go in an issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node 24 or newer (`.nvmrc` pins the version) and a recent npm.

```bash
git clone https://github.com/Dezfil/Dezfil.git
cd Dezfil
npm ci
npm run dev
```

The app comes up on <http://localhost:3000> and keeps its data in `./data`.
Some tests build vector tiles with a native tiler; if you do not have one on
your `PATH`, those tests will tell you so.

## Run the gates

These are the same checks the pipeline runs on your pull request. Run them
before you push.

```bash
npm run lint          # code style
npm run typecheck     # types
npm test              # unit and integration tests
```

There are also several narrower gates, each guarding one property of the
repository. The pipeline runs all of them, and so should you if you touched
the area concerned:

```bash
npm run lint:hygiene    # no binary junk in source files
npm run lint:readme     # every setting the server reads is documented
npm run lint:size       # the oversized modules do not grow
npm run lint:stage-edge # nothing development-only reaches a production build
npm run lint:wheelhouse # the design system's vocabulary
npm run lint:tokens
npm run lint:icons
npm run lint:class-pairs # no tie between two stylesheets left to load order
npm run lint:specimen   # the design specimen page is regenerated
npm run lint:plugin     # the shipped plugin manifests
```

The end-to-end browser suite is not part of the normal loop and the pipeline
does not run it. Run it yourself when you have changed something only a
browser can judge:

```bash
npx playwright install chromium   # first run on a machine
npm run journey:browser           # every spec under e2e/, against a running instance
```

It needs a running server and a provisioned browser, and several settings on
the server before a full run is green. [Checks and testing](docs/develop/checks-and-testing.md)
lists them, and [docs/operate/runbook.md](docs/operate/runbook.md) covers the subsets and what a
failure usually means.

## Branches and pull requests

- Cut a branch from `main`. Keep it short-lived and keep it to one subject.
- One pull request does one thing. A change that is easy to review is a change
  that gets merged.
- Describe what changed and why. If it changes what a user sees, say what they
  will see, and add a screenshot.
- Keep the pull request green. The fast lane runs on every push to it.
- Do not merge your own pull request without a review.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>
```

Common types are `feat`, `fix`, `docs`, `refactor`, `test` and `chore`. Use
`!` after the type or scope, or a `BREAKING CHANGE:` footer, for a breaking
change. Examples:

```
feat(builder): add a hidden-group toggle
fix(publish): keep the assistant flag across a republish
docs: explain the egress allowlist
```

Write a body for anything substantial: the reason, the resulting behaviour,
and how you checked it.

Keep commit messages about the code. A pipeline check rejects messages that
carry internal tracking references from the project's own history.

## Sign your work: the Developer Certificate of Origin

Every commit must carry a `Signed-off-by` line. Git adds one for you:

```bash
git commit -s -m "fix(export): keep the basemap credit inside the frame"
```

which appends

```
Signed-off-by: Your Name <your.email@example.com>
```

using your configured `user.name` and `user.email`. Use your real name. A
pipeline check rejects a pull request with an unsigned commit; if you forget,
`git rebase --signoff main` fixes the whole branch.

That line means you agree to the Developer Certificate of Origin, version 1.1,
reproduced below and published at <https://developercertificate.org/>:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

The sign-off records a certification about where the code came from. It does
not grant rights you do not have.

## Licensing

Dezfil is licensed under Apache-2.0; see [LICENSE](LICENSE). Contributions you
submit are licensed under the same terms, as section 5 of that license sets
out.

If you bring in code from another project, it must be under a license
compatible with Apache-2.0. Keep the original file header, and add the source
to [NOTICE](NOTICE) in the same commit.

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
