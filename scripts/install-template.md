# Shipping a template release

`npm run templates:install` runs `scripts/install-template.mjs`. It installs
one released template archive into the shipped set under `templates/`, which
the image copies and every instance reads with no network.

From a release checkout with its dependencies and the DuckDB extensions
installed, run:

```sh
npm run templates:install -- <ARCHIVE> --sha256 <RELEASE_SHA256> --size <RELEASE_BYTES>
```

`<ARCHIVE>` is the release's `.zip` file, or its HTTP(S) address. Take the
checksum and the byte count from the release. `--target <FOLDER>` installs
into another folder than `templates/`.

The command checks the transfer, reads the archive and its datasets, and
checks the bindings and the whole shipped set in a temporary instance of its
own. Only then does it publish the template's `<id>/<version>/` folder and
`index.json` together. A refused install leaves the existing set unchanged.

- A newer version replaces that template's shipped version. An older one
  replaces it only with `--allow-downgrade`.
- The same version again is refused: released versions are immutable.
- A remote transfer is bounded by `DEZFIL_REMOTE_TIMEOUT_S` (300 seconds by
  default). Its requests carry the user agent
  `Dezfil-templates/1.0 (+https://dezfil.io)` and no account credentials.

A successful install prints `Installed <id> version <version> into <target>`.
Commit what changed under `templates/`.
