# The documentation's pictures: proving a run

How to show that `npm run docs:pictures` is repeatable, that a change to the
app moves only the pictures that show it, and that a scene which shows a map
reaches the built-in basemap and nothing else. The request rule itself is
held by the unit suite (`src/lib/docs-pictures-network.test.ts`); these runs
show it in a browser.

## Before you start

Use a detached worktree at the commit you are proving, with the lockfile's
modules installed, a production build and no `.env` files, and the Chromium
and ffmpeg that Playwright installs:

```sh
npm ci
npm run build
npx playwright install chromium ffmpeg
```

Every command below runs from that worktree, on a port of your choosing other
than 3000 (`3411` here). A map scene draws the live built-in basemap, so the
machine needs to reach the basemap's host. Each run starts and stops its own
instance over a scratch folder, and writes only under `docs/images/`.

## Two runs change nothing

```sh
npm run docs:pictures -- --port 3411
find docs/images -type f | sort | xargs shasum -a 256 > /tmp/pictures-run-1.txt
npm run docs:pictures -- --port 3411
find docs/images -type f | sort | xargs shasum -a 256 > /tmp/pictures-run-2.txt
diff /tmp/pictures-run-1.txt /tmp/pictures-run-2.txt
```

The second run ends with `0 changed` and `0 removed`, `diff` prints nothing
(the manifest is in both lists), and the two runs print the same lines under
"The map scenes drew the built-in basemap from". The first run may change
files when the tree's pictures are older than the build.

The basemap's provider moves its tiles to a new tile set when it publishes
new map data, every few days. If the second run names another tile set than
the first, the map pictures may change with it: that is the basemap's
change, not the app's. Run both again until they name the same set.

A data layer is drawn in the order its query returns its rows, and
overlapping translucent marks blend in that order. If a map scene's
picture changes between two runs that drew the same basemap, look at its
layers: rows that tie under the layer's `ORDER BY` can arrive in another
order. Give the scene's map a layer whose rows are in a total order, or
fewer overlapping marks.

## A label change moves only its scenes

1. Choose a label that one or more scenes show and the others do not, and
   change its words in the source.
2. Run `npm run build`, then `npm run docs:pictures -- --port 3411`.
3. `git status --porcelain docs/images` lists the light and dark takes of
   the scenes that show the label (and a recording's posters), and the
   manifest. `git diff docs/images/manifest.json` moves the version and date
   of those files' rows only.
4. Undo the label change and run `npm run build` again.

## A map scene reaches the built-in basemap and nothing else

Each case is a temporary edit, a run of one map scene (`--only <scene>`), and
the edit undone. Every case fails the run before anything is written:
`git status --porcelain docs/images` stays empty, and the message names each
address.

- **The basemap's host cannot be reached.** In `openBrowser`
  (`scripts/docs-pictures-capture.mjs`), add the Chromium argument
  `--host-resolver-rules=MAP tiles.openfreemap.org 127.0.0.1:9`. The run
  stops at the scene's light take with "the built-in basemap did not load",
  naming the style's address and `net::ERR_CONNECTION_REFUSED`.
- **The basemap's tiles cannot be reached.** At the start of the map scene's
  `open`, add
  `await page.route((url) => url.pathname.endsWith(".pbf"), (route) => route.abort("connectionrefused"));`.
  The run names the tile addresses the map asked for.
- **An unrelated host, from a map scene.** At the end of the map scene's
  `open`, add
  `await page.evaluate(() => fetch("https://unrelated.example/seed.json").catch(() => null));`.
  The run says the page asked for addresses "off the instance and off the
  built-in basemap" and names that address.
- **An unrelated host, from a scene that shows no map.** The same line in a
  scene without `map: true`. The run says the page asked for addresses "off
  the instance" and names it.
- **The basemap's host, from a scene that shows no map.** Remove `map: true`
  from the map scene. The run names the basemap's addresses and says that the
  basemap is reached only from a scene declared with `map: true`.

A run that passes says the server opened no request off the instance (the
server asks its own listener whether it answers before it makes map card
pictures; that request stays inside the run) and lists the basemap's styles
and tile sets the map scenes drew.

The run's server makes no map card picture, on any machine: its
`DEZFIL_CHROMIUM_PATH` names a file in the scratch folder that does not
exist. A map the run makes has no picture to inherit, and a server that
found a browser would start one and talk to it, a request off the instance
that fails the run. The pages come out the same on every machine for it:
a page of map cards always shows the administrator the line about a missing
renderer, and the Maps scene's crop leaves that line out.
