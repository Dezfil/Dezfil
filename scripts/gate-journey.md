# Authentication gate probe

The authentication probes run against an already running scratch instance.

`npm run probe:gate -- <base-url>` checks protected operations and anonymous
exceptions. Start it on an empty store so it can check setup before provisioning.
