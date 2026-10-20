# Sign-in limit probe

The authentication probes run against an already running scratch instance.

`npm run probe:login -- <port>` checks socket-based sign-in limits and waits
for recovery at the real retry deadline (about fifteen minutes). Use a fresh store
and a dual-stack listener with `DEZFIL_TRUSTED_PROXIES=127.0.0.1`; `--no-wait`
omits only the recovery check.
