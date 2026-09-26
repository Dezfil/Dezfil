/**
 * The server-owned PostGIS connection input contract. This module is
 * deliberately browser-safe: the shared form uses the same URL interpreter
 * as the API, while persistence and source contact stay server-side.
 */

export interface ConnectionValues {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export interface ParsedConnectionUrl {
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

export interface ConnectionEndpoint {
  host: string;
  port: number;
}

export class ConnectionInputError extends Error {}

const LABELS: Record<keyof Pick<ConnectionValues, "name" | "host" | "database" | "username" | "password">, string> = {
  name: "Connection name",
  host: "Host",
  database: "Database",
  username: "Username",
  password: "Password",
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sslRequired(modes: string[]): boolean | undefined {
  const supplied = new Set(modes.filter(Boolean).map((mode) => mode.toLowerCase()));
  if (supplied.size === 0) return undefined;
  const [mode] = supplied;
  if (supplied.size !== 1 || !["require", "prefer", "disable", "allow"].includes(mode)) {
    throw new ConnectionInputError(
      "This URL uses an unsupported or conflicting SSL mode; use require for SSL required, or prefer, disable or allow for SSL not required.",
    );
  }
  return mode === "require";
}

function parseKeyValue(text: string): { values: Record<string, string>; modes: string[] } | null {
  const values: Record<string, string> = {};
  const modes: string[] = [];
  let at = 0;
  while (at < text.length) {
    while (/\s/.test(text[at] ?? "")) at += 1;
    if (at >= text.length) break;
    const key = text.slice(at).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!key) return null;
    at += key[0].length;
    let value = "";
    const quote = text[at] === "'" || text[at] === '"' ? text[at++] : null;
    if (quote) {
      let closed = false;
      while (at < text.length) {
        const ch = text[at++];
        if (ch === "\\" && at < text.length) {
          value += text[at++];
        } else if (ch === quote) {
          closed = true;
          break;
        } else {
          value += ch;
        }
      }
      if (!closed || (at < text.length && !/\s/.test(text[at]))) return null;
    } else {
      const start = at;
      while (at < text.length && !/\s/.test(text[at])) at += 1;
      value = text.slice(start, at);
    }
    const name = key[1].toLowerCase();
    values[name] = value;
    if (name === "sslmode") modes.push(value);
  }
  return Object.keys(values).length > 0 ? { values, modes } : null;
}

/** Interpret the two accepted Postgres URL forms without retaining the URL. */
export function parseConnectionUrl(value: string): ParsedConnectionUrl {
  const text = value.trim().replace(/^psql\s+/i, "").replace(/^(['"])(.*)\1$/, "$2");
  if (/^postgres(?:ql)?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname) {
        throw new Error("invalid");
      }
      return {
        host: parsed.hostname,
        port: parsed.port || undefined,
        database: decode(parsed.pathname.replace(/^\//, "")),
        username: decode(parsed.username),
        password: decode(parsed.password),
        ssl: sslRequired(parsed.searchParams.getAll("sslmode")),
      };
    } catch (error) {
      if (error instanceof ConnectionInputError) throw error;
      throw new ConnectionInputError("That does not look like a Postgres URL.");
    }
  }

  const parsed = parseKeyValue(text);
  if (!parsed || !Object.hasOwn(parsed.values, "host")) {
    throw new ConnectionInputError("That does not look like a Postgres URL.");
  }
  const { values, modes } = parsed;
  return {
    host: values.host,
    port: values.port,
    database: values.dbname ?? values.database ?? "",
    username: values.user ?? values.username ?? "",
    password: values.password ?? "",
    ssl: sslRequired(modes),
  };
}

type Input = Record<string, unknown>;

function has(input: Input, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function stringField(
  input: Input,
  field: string,
  trim = true,
): string | undefined {
  if (!has(input, field)) return undefined;
  if (typeof input[field] !== "string") {
    throw new ConnectionInputError(`${LABELS[field as keyof typeof LABELS] ?? field} must be a string.`);
  }
  const value = input[field] as string;
  return trim ? value.trim() : value;
}

function parsedUrl(input: Input): ParsedConnectionUrl {
  if (!has(input, "url")) return {};
  if (typeof input.url !== "string" || !input.url.trim()) {
    throw new ConnectionInputError("That does not look like a Postgres URL.");
  }
  return parseConnectionUrl(input.url);
}

function portValue(input: Input, fromUrl: ParsedConnectionUrl, fallback: number): number {
  const raw = has(input, "port") ? input.port : (fromUrl.port ?? fallback);
  const port = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (!Number.isInteger(port) || Number(port) <= 0 || Number(port) > 65535) {
    throw new ConnectionInputError("The port is invalid.");
  }
  return Number(port);
}

function sslValue(input: Input, fromUrl: ParsedConnectionUrl, fallback: boolean): boolean {
  if (has(input, "ssl")) {
    if (typeof input.ssl !== "boolean") {
      throw new ConnectionInputError("SSL must be true or false.");
    }
    return input.ssl;
  }
  return fromUrl.ssl ?? fallback;
}

function requireValues(values: ConnectionValues): ConnectionValues {
  for (const field of ["name", "host", "database", "username", "password"] as const) {
    if (!values[field]) {
      throw new ConnectionInputError(`${LABELS[field]} is required.`);
    }
  }
  return values;
}

function normalizedIpv6Host(host: string): string | null {
  const unbracketed = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (!unbracketed.includes(":")) return null;
  try {
    const normalized = new URL(`http://[${unbracketed}]/`).hostname;
    return normalized.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

/** Compare stored and candidate destinations without consulting DNS. */
export function connectionEndpointsEqual(
  left: ConnectionEndpoint,
  right: ConnectionEndpoint,
): boolean {
  const leftHost = left.host.trim();
  const rightHost = right.host.trim();
  const leftIpv6 = normalizedIpv6Host(leftHost);
  const rightIpv6 = normalizedIpv6Host(rightHost);
  const hostsEqual = leftIpv6 !== null || rightIpv6 !== null
    ? leftIpv6 !== null && rightIpv6 !== null && leftIpv6 === rightIpv6
    : leftHost.replace(/\.$/, "").toLowerCase() ===
      rightHost.replace(/\.$/, "").toLowerCase();
  return hostsEqual && Number(left.port) === Number(right.port);
}

export function resolveCreateConnectionInput(input: Input): ConnectionValues {
  const fromUrl = parsedUrl(input);
  return requireValues({
    name: stringField(input, "name") ?? "",
    host: stringField(input, "host") ?? fromUrl.host?.trim() ?? "",
    port: portValue(input, fromUrl, 5432),
    database: stringField(input, "database") ?? fromUrl.database?.trim() ?? "",
    username: stringField(input, "username") ?? fromUrl.username?.trim() ?? "",
    password: has(input, "password")
      ? (stringField(input, "password", false) ?? "")
      : (fromUrl.password ?? ""),
    ssl: sslValue(input, fromUrl, true),
  });
}

export function resolveUpdateConnectionInput(
  input: Input,
  current: ConnectionValues,
): {
  values: ConnectionValues;
  connectivityChanged: boolean;
  endpointChanged: boolean;
  passwordFromStore: boolean;
  passwordReentryRequired: boolean;
} {
  const fromUrl = parsedUrl(input);
  const explicitPassword = stringField(input, "password", false);
  const passwordFromStore = !(
    (explicitPassword !== undefined && explicitPassword !== "") ||
    fromUrl.password
  );
  const password = passwordFromStore
    ? current.password
    : explicitPassword !== undefined && explicitPassword !== ""
      ? explicitPassword
      : fromUrl.password!;
  const values = requireValues({
    name: stringField(input, "name") ?? current.name,
    host: stringField(input, "host") ?? fromUrl.host?.trim() ?? current.host,
    port: portValue(input, fromUrl, current.port),
    database:
      stringField(input, "database") ?? fromUrl.database?.trim() ?? current.database,
    username:
      stringField(input, "username") ?? fromUrl.username?.trim() ?? current.username,
    password,
    ssl: sslValue(input, fromUrl, current.ssl),
  });
  const connectivityChanged =
    values.host !== current.host ||
    values.port !== current.port ||
    values.database !== current.database ||
    values.username !== current.username ||
    values.password !== current.password ||
    values.ssl !== current.ssl;
  const endpointChanged = !connectionEndpointsEqual(values, current);
  const passwordReentryRequired =
    passwordFromStore &&
    (endpointChanged || (current.ssl && !values.ssl));
  return {
    values,
    connectivityChanged,
    endpointChanged,
    passwordFromStore,
    passwordReentryRequired,
  };
}
