---
title: "How this is built"
summary: "Take a change from an idea to main: describe the behavior, build it on a branch with its tests, pass the checks and get it reviewed."
read_when:
  - "you plan to contribute a change and want to know what is expected of it"
  - "you write a change with an AI coding agent"
  - "you want to know what a reviewer looks for before a pull request merges"
  - "you say in a pull request what you tested and what you did not"
  - "a pull request check says a commit is not signed off or its message carries an internal reference"
audience:
  - developer
  - agent
checked: none
order: 3
moved_from:
  - "/docs/develop/how-this-is-built/"
---

Every change to Dezfil takes the same steps, whether a person or an AI coding agent writes it:

| Step | What you do | What holds it |
|---|---|---|
| [1. Describe](#1-describe-the-change) | Say what a user will notice, in an issue | The issue forms |
| [2. Build](#2-build-it-on-a-branch) | Commit on a branch, with tests | Conventional Commits and a sign-off |
| [3. Check](#3-run-the-checks) | Run the checks before you push | The pipeline, on every pull request |
| [4. Open a pull request](#4-open-a-pull-request) | Say what changed and how you checked it | The pull request template |
| [5. Review](#5-get-it-reviewed) | A second reader reads the diff | The reviewer, then a maintainer's merge |

## 1. Describe the change

For anything larger than a typo, open an issue first, at <https://github.com/Dezfil/Dezfil/issues/new/choose>. Pick the form that fits:

| Form | What it asks for |
|---|---|
| Feature request | The problem, the behavior you would like from a user's point of view, and what you do today instead |
| Bug report | What happened, the steps to reproduce it, the version, how you run Dezfil, and any logs |

You should see your issue open with the label its form sets: `enhancement` or `bug`.

Describe behavior, not code: what a user will see or be able to do, how you will know it works, and what the change leaves out.

The costlier a mistake would be, the more you describe first. If the change breaks the API, as [Architecture](architecture.md#rules-every-change-keeps) defines a breaking change, say so in the issue.

Report a security problem privately, as [SECURITY.md](../../SECURITY.md) says, never in an issue. Ask questions in [Discussions](https://github.com/Dezfil/Dezfil/discussions).

> [!NOTE]
> Dezfil's scope is narrow on purpose: make a map, add layers, style it, publish it. Organizations, single sign-on, audit logs, per-item grants and warehouse connectors are outside its model. If a change seems to need one, raise that in the issue.

## 2. Build it on a branch

```sh title="Terminal"
git switch -c fix/legend-range main
git add <CHANGED_FILES>
git commit -s -m "fix(legend): show the new range after a colormap change"
git log -1 --format=%B
```

```text title="Output"
fix(legend): show the new range after a colormap change

Signed-off-by: <YOUR_NAME> <<YOUR_EMAIL>>
```

- `fix/legend-range` names the branch by its kind and its subject. Cut it from `main` and keep it to one subject: a defect you find on the way past gets its own issue.
- `git add <CHANGED_FILES>` stages the files you edited, so the commit takes them.
- `fix(legend): ...` is a Conventional Commits message: a type, an optional scope, then what the change does.
- `-s` adds the `Signed-off-by` line from your `user.name` and `user.email`. With it you certify the Developer Certificate of Origin, under your real name.

Write a body for anything substantial: why, the behavior that results, how you checked it and what that did not cover. [Contributing](../../CONTRIBUTING.md) lists the commit types and holds the certificate.

A change ships with its tests. Prefer a test that fails before the change and passes after it: a test that cannot fail only turns an assumption into a green tick.

Keep to these while you build:

- **API first:** new behavior starts as a documented API operation, which the UI calls like any other client. What a person can do in the app, an agent can do too.
- **Docs in the same change:** if a page under `docs/` describes what you changed, fix the page too. [Write a docs page](write-docs.md) holds the rules.
- **Large modules shrink:** the oversized modules listed in `scripts/check-monster-files.mjs` must not grow. Extract the piece you touch, and start new logic in a new module.
- **Borrowed code keeps its header:** code from a permissively licensed project keeps its licence header and gets a line in [NOTICE](../../NOTICE). Copyleft code is reference only.

If an AI coding agent writes the change, start it on [AGENTS.md](../../AGENTS.md). It holds the constraints every change keeps, and points the agent at the [documentation index](../README.md).

## 3. Run the checks

```sh title="Terminal"
npm run lint
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
DEZFIL_DATA_DIR="$(mktemp -d)" npm test
```

- `npm run lint` runs ESLint over the repository.
- `npm run typecheck` checks the types with the TypeScript compiler and emits no JavaScript. `NODE_OPTIONS` gives it 4 GB of heap, as the pipeline does.
- `npm test` runs the unit and integration suite. `DEZFIL_DATA_DIR` gives it an empty scratch folder, so the suite never touches your real data. Its tile tests need `tippecanoe` on your `PATH`: [Development setup](development-setup.md#add-the-programs-the-container-brings) says how to install it.

You should see each command finish without an error.

Each narrower check, such as `npm run lint:docs`, holds one property of the repository. Run the ones your change could break. [Development setup](development-setup.md#run-the-checks) lists them all.

The pipeline runs the checks again on every pull request and every push to `main`, and a new push to a pull request cancels the run still going:

| Job | When it runs | What it does |
|---|---|---|
| `checks` | Every pull request and every push to `main` | Lint, types, every narrower check, the unit suite, and the two checks of the ingress preload |
| `secrets` | Every pull request and every push to `main` | Scans the working tree for secrets with gitleaks |
| `commits` | Every pull request | Checks that every commit is signed off and that no commit message cites an internal tracking reference |
| `image` | Every push to `main`, so after a merge | Builds the container, checks what it holds, and drives it with no network: ready within 30 seconds, the API journey, then the ownership and sharing journeys, each seeded on a fresh volume and verified after the container is replaced. [`ci.yml`](../../.github/workflows/ci.yml) lists every step. |

The browser suite is outside the pipeline. When only a browser can judge your change, run `npm run journey:browser` yourself, as [Development setup](development-setup.md#run-the-browser-suite) describes.

## 4. Open a pull request

Push the branch to your fork of the repository, or to the repository itself if you can push there, and open a pull request against `main`. With the GitHub CLI, `gh pr create --base main` offers to fork and push for you.

The description starts from the project's [template](../../.github/PULL_REQUEST_TEMPLATE.md):

| Section | What you write |
|---|---|
| What this changes | One or two sentences: what is different after it merges |
| Why | The problem it solves, and the issue it closes, such as `Fixes #123` |
| How it was checked | The commands you ran, and what you looked at by eye |
| For a reviewer | A trade-off you made, a place you were unsure, a behavior only a browser shows, and a screenshot if the interface changed |
| Before you open this | The sign-off, Conventional Commits, borrowed code in NOTICE, and docs that match what ships |

You should see the `checks`, `secrets` and `commits` jobs start on the pull request. On a first pull request from a fork, they may wait until a maintainer approves the run.

Under How it was checked, name each command you ran and read the output of, and say plainly what you did not run.

Give each claim one of these labels. "Verified" on its own is not one of them:

| Label | Use it when |
|---|---|
| confirmed | The code path, a test or a run demonstrates the claim directly |
| confirmed mechanism, unmeasured impact | The code makes the behavior certain, but how much it matters to a user needs a profile or a reproduction |
| plausible | Reading the code makes it credible, and a concurrency, failure-injection or browser test would settle it |
| comparative judgment | It depends on what users expect, or on what another product does |

An untested branch of the code stays unverified, however convincing its sibling looks.

## 5. Get it reviewed

A second reader reads the diff before it merges: a person or an agent that did not write the change, starting fresh. Never merge your own pull request without a review.

When an AI agent wrote the change, a maintainer has it reviewed by a model of another family, which shares fewer of its blind spots.

The reviewer reads the change against its description and looks hardest at what its author's own checking tends to miss:

| What | What the reviewer asks |
|---|---|
| The description | Does the change do what its issue describes, and nothing outside it? |
| Tests that can fail | Could each new test fail? An assertion whose two sides come from the same code path, or an absence check against data that never held the value, cannot. |
| Claims and evidence | Does the evidence cover every part of the claim? "X and Y each do Z" needs both shown. |
| References | Does every path, test, command or script the change names exist? |
| Measurements | Is the harness right? A benchmark is code too, and a wrong number is a defect. |
| The API | Can an agent do through the API what a person can do in the app? |
| Docs and licences | Do the pages match the behavior, and does borrowed code keep its header and its NOTICE line? |

Review findings are input, not instructions: each is adopted when it holds up, or declined with a reason on the pull request. Push each fix as a new commit.

Once the checks pass and the review settles, a maintainer merges the pull request with a merge commit. It keeps each of your commits, and the change's boundary, in the history.

You should see the pull request marked Merged, and the `image` job start on `main`, where it builds the container.

## Troubleshooting

**The `commits` job says "Missing Signed-off-by".** A commit lacks the sign-off line. Sign every commit on the branch with `git rebase --signoff main`, then force-push the branch.

**The `commits` job says a message "carries a planning document number", "a tracking row identifier" or "a path this repository does not carry".** Reword the commit, writing what the change does instead of the reference, then force-push. For the last commit, run `git commit --amend -s -m "<NEW_MESSAGE>"`; for an earlier one, `git rebase -i main`.

**`npm run lint:citations` says a file "cites" something.** A tracked file points at a document this repository does not carry. Write the reason in its place, not the reference.

**`npm test` fails with "Authenticated fixtures require a scratch DEZFIL_DATA_DIR" or "DEZFIL_DATA_DIR must name a scratch directory".** The suite needs a scratch folder. Set `DEZFIL_DATA_DIR` as in [step 3](#3-run-the-checks).

**`npm run lint:size` says a module is "below its ceiling".** Your change shrank one of the oversized modules. Lower its ceiling to the new line count in `scripts/check-monster-files.mjs`, in the same change.

## Next steps

- [Development setup](development-setup.md): run a checkout, every check and the tests.
- [Architecture](architecture.md): how the container is put together, and where each piece lives.
- [Write a docs page](write-docs.md): the rules a page follows and the checks that hold them.
- [Contributing](../../CONTRIBUTING.md): commit types, the certificate and licensing.
