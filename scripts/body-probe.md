# JSON body and MCP admission probe

Use an isolated production standalone or container, never a working data store.
The full probe includes the large-upload and paced anonymous transport arms,
then drives every documented JSON reader at minus-one, exact and plus-one
bytes with declared and chunked UTF-8 and escaped input. It exercises maximal
sketch, icon, export and viewer fixtures, compares resource state after
refusals, and counts all rows in the stock MCP client's near-ceiling upload.
It prints each fixture's bytes, MCP envelope overhead, check counts and elapsed
seconds. Keep the separate 1 MiB upload-limit arm.

The server must preload ingress, use `DEZFIL_UPLOAD_MAX_MB=257`, and enable
the assistant with `DEZFIL_AI_PROVIDER=openai OPENAI_API_KEY=scripted-wire`.
The assistant controls refuse in validation, before any provider call. The
workstation server also needs `DEZFIL_CHROMIUM_PATH` pointing to its headless
browser and `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1`, as in the journeys, for the
export control. Without the browser it answers 503 and stops the probe. The
container supplies the browser and needs no extra export configuration. The
client's `DEZFIL_DATA_DIR` must point at the server's isolated data directory
so it can observe upload scratch growth. Use port 3391 for the full arm and
3392 for the 1 MiB arm. The client install needs the lockfile's stock MCP
client; the separate probe image supplies it without adding it to production.

External arrival needs a second isolated instance on port 3393 with
[external sign-in configured](../docs/self-host/configuration/external-sign-in.md).
Give it its own data directory and a synthetic first owner and public key.
The probe sends malformed bodies without a session or a ticket, so it needs
no private key and never contacts the sign-in service. Both instances must
be freshly started to keep the failed-sign-in budget clear. A disabled
arrival or exhausted budget fails the control instead of skipping its bound.

Against already running production standalones on ports 3391 and 3393:

```sh
DEZFIL_DATA_DIR="$PWD/.claude/test-data/body-server" npm run probe:body -- http://127.0.0.1:3391 --server-log "$PWD/.claude/logs/body-server.log" --external-origin http://127.0.0.1:3393
```

Against a container named `dezfil-body`, with its log at
`/data/body-server.log`, use the separately built `dezfil-mcp-probe:ci` image:

```sh
docker run --rm --network=container:dezfil-body --volumes-from dezfil-body -e DEZFIL_DATA_DIR=/data -v "$PWD/scripts:/probe/scripts:ro" dezfil-mcp-probe:ci node /probe/scripts/body-probe.mjs http://127.0.0.1:3391 --server-log /data/body-server.log --external-origin http://127.0.0.1:3393
```

On a separate instance configured with `DEZFIL_UPLOAD_MAX_MB=1`:

```sh
DEZFIL_DATA_DIR="$PWD/.claude/test-data/file-limit-server" DEZFIL_UPLOAD_MAX_MB=1 npm run probe:transport -- http://127.0.0.1:3392 --server-log "$PWD/.claude/logs/file-limit-server.log" --file-limit-only
```

Run the external-sign-in container in the same network namespace, listening
on 3393 with a separate data volume.

Green exits zero with `"label":"confirmed"`, 70 JSON operations and 840
boundary checks, the measured fixture bytes, and a counted MCP upload. A red
exits nonzero with `"label":"failed"` and the failed assertion. Truncation, a
swallowed refusal, an unbounded MCP handoff, changed resource state, missing
rows, an unavailable renderer, or missing evidence all fail the probe. The
route-level unit uses the same probe with an injected transport and image
renderer; it does not establish real-socket or framework-copy behavior.
