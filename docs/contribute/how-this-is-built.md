---
title: "How this is built"
summary: "The method behind the repository: each change described as behavior first, written largely by AI coding agents and reviewed before it lands."
read_when:
  - "you plan to contribute a change"
  - "you wonder why the repository looks the way it does"
audience:
  - developer
checked: none
moved_from:
  - "/docs/develop/how-this-is-built/"
---

This project is written largely by AI coding agents, under a method that is worth
stating plainly: it explains why the repository looks the way it does, and it tells a
contributor what is expected of a change.

## A change starts as a description of behavior

Before implementation, a change is described in terms of what a user would notice: the
behavior, the acceptance criteria, what is explicitly out of scope. The description
avoids function names, signatures and pseudo-code, because those are decisions the
implementation makes better. Only once the description is settled does the work move on
to how it will be done, and then to the order the steps take.

The rule is a spectrum rather than a ritual. A change whose surface is already known,
which introduces nothing a user would have to decide, and whose steps would restate the
description, is written directly. The costlier the mistake, the more description it is
worth writing first.

Where the implementation ends up differing from the description, the description is
corrected. Documentation mirrors the implementation, never the other way round: a
document that disagrees with working code is a document to fix.

## Every change is read by a different model

A change is reviewed before it lands by a model from a different family than the one
that wrote it, reading the diff from a fresh context, with the automated checks already
green so the reading is not spent on what a linter would catch.

This is not ceremony. Four classes of defect reliably survive the model that wrote them
and are caught here:

- **A check that cannot fail.** An assertion whose two sides come from the same code
  path, an absence check against a payload that never carried the value, a timeout test
  against a call that returns before the timer arms.
- **An overclaimed closure.** Work marked done in terms its own evidence does not
  support. Criteria of the form "an X and a Y each do Z" evidenced by one of the two.
- **A citation that resolves to nothing.** A path, a test or a script name that does
  not exist.
- **A defect in the measurement.** A benchmark is code too, and a wrong number
  presented as a fact is worse than no number.

Review findings are input, not instructions. A finding is adopted when it stands up to
scrutiny and declined with a reason when it does not.

## Evidence has a vocabulary

Any claim that something works carries one of four labels, and "verified" on its own is
not one of them:

- **confirmed** - the code path or the artifact demonstrates the claim directly.
- **confirmed mechanism, unmeasured impact** - deterministic in code, but the
  user-facing magnitude needs a profile or a reproduction before it drives priority.
- **plausible** - credible from reading the code, and in need of a concurrency test, a
  failure injection or a browser run before it is more than that.
- **comparative judgment** - depends on what a user expects, and is never "verified".

An untested branch is not verified, however convincing its sibling looks.

## Testing is layered because no layer is enough

Each layer holds what the one below it cannot see.

1. **The automated suites** hold repeatable behavior: types, lint, unit tests, the API
   journey. They are the floor and they run in the pipeline.
2. **Browser journeys** hold flows end to end. They cannot judge how something feels.
3. **Pixel regressions** hold what an agent cannot see: transparency arithmetic, icon
   rendering, whether an animation is actually running.
4. **A human looking at the screen** is the last word on interaction.

The ratchet matters more than the layers: anything a human catches by eye becomes an
automated check, so the same class of defect is never found by hand twice.

## Some habits that are load-bearing

- **Put quality where the checks can see it.** Agents build what is verified. To raise
  quality somewhere, add an acceptance criterion or a pipeline check. Exhortation in
  prose does nothing.
- **Oversized modules shrink at the change that touches them.** A change that touches a
  large module extracts the piece it worked on, and new logic starts in a new module.
  Never a rewrite sprint, which is where behavior quietly changes.
- **Finding a defect is not authorization to fix it.** Work that discovers an unrelated
  defect records it and carries on, so a scoped change stays scoped.
- **When two notes disagree, run the thing.** Never resolve a contradiction by
  preferring the more recent note.

## What this means for a contribution

A change is welcome from a human or an agent. Either way it carries its tests, its
claims carry the evidence vocabulary above, and it states plainly what it did not
verify. A pull request that says what it could not prove is more useful than one that
implies it proved everything.
