/** Values whose omission requests no unsupported mandatory protection.
 * Empty values remain absent. All other nonempty values for these keys
 * are refused; nothing in this inventory is forwarded to libpq. The API
 * guide's Connections table lists every key, held by a test. */
export const IGNORED_VALUES: Record<string, readonly string[]> = {
  options: [],
  service: [],
  min_protocol_version: [],
  channel_binding: ["prefer", "disable"],
  ssl_min_protocol_version: [],
  ssl_max_protocol_version: [],
  gssencmode: ["prefer", "disable"],
  sslrootcert: [],
  sslcrl: [],
  sslcrldir: [],
  sslcert: [],
  sslkey: [],
  sslpassword: [],
  sslcertmode: ["allow"],
  require_auth: [],
  krbsrvname: [],
  gsslib: [],
  sslsni: ["1"],
  sslcompression: ["0", "1"],
  gssdelegation: ["0", "1"],
  sslnegotiation: ["postgres"],
  requiressl: ["0"],
  ssl: ["false"],
  scram_client_key: [],
  scram_server_key: [],
  oauth_issuer: [],
  oauth_client_id: [],
  oauth_client_secret: [],
  oauth_scope: [],
};

/** Inspect occurrences in input order, before any last-value reduction.
 * requirepeer is deliberately absent: its peer-user check applies only to
 * Unix sockets, whereas the app always uses a guarded TCP address. */
export function unsupportedProtection(entries: Iterable<[string, string]>): string | undefined {
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (value !== "" && Object.hasOwn(IGNORED_VALUES, name) && !IGNORED_VALUES[name].includes(value)) {
      return name;
    }
  }
}
