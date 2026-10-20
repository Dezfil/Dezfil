# Anonymous published access probe

The authentication probes run against an already running scratch instance.

`npm run probe:published-auth -- <base-url>` checks anonymous published data,
widgets and real tiles. Set `DEZFIL_RENDER_CAP_FEATURES=2000` on the server and
keep `tippecanoe` on its `PATH`.
