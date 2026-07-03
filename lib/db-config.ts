type PgConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /**
   * Set to `false` only when the connection string explicitly opts out of
   * SSL via `sslmode=disable` (e.g. the throwaway/CI test-DB container,
   * which is plain Postgres with no SSL listener). Undefined preserves
   * today's behavior everywhere else (`ssl: { rejectUnauthorized: false }`
   * in lib/db.ts).
   */
  ssl?: false;
};

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseConnectionString(connectionString: string): PgConfig | null {
  const match = connectionString.match(/^postgres(?:ql)?:\/\/(.+)$/i);
  if (!match) {
    return null;
  }

  const body = match[1];
  const atIndex = body.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }

  const authPart = body.slice(0, atIndex);
  const locationPart = body.slice(atIndex + 1);
  const authSeparator = authPart.indexOf(":");
  if (authSeparator === -1) {
    return null;
  }

  const user = decodeSegment(authPart.slice(0, authSeparator));
  const password = decodeSegment(authPart.slice(authSeparator + 1));

  const slashIndex = locationPart.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const hostPort = locationPart.slice(0, slashIndex);
  const databasePart = locationPart.slice(slashIndex + 1);
  const hostSeparator = hostPort.lastIndexOf(":");
  const host = hostSeparator === -1 ? hostPort : hostPort.slice(0, hostSeparator);
  const port = hostSeparator === -1 ? 6543 : parseInt(hostPort.slice(hostSeparator + 1), 10);
  const database = decodeSegment(databasePart.split(/[?#]/, 1)[0] || "postgres");
  const query = databasePart.split(/[?#]/, 2)[1] ?? "";
  const sslDisableRequested = /(?:^|&)sslmode=disable(?:&|$)/i.test(query);

  if (!host || !user || !password || Number.isNaN(port)) {
    return null;
  }

  // `sslmode=disable` is only honored for loopback hosts (the throwaway/CI
  // test-DB container, or a developer's own machine) — never for a real
  // remote host such as the production Supabase instance. Any real
  // DATABASE_URL that somehow carried this flag (operator misconfiguration)
  // keeps the default SSL-required behavior instead of silently downgrading
  // to plaintext; a loud warning either way makes both outcomes visible in
  // logs rather than a silent no-op or a silent downgrade.
  if (sslDisableRequested) {
    if (isLoopbackHost(host)) {
      console.warn(`[db] SSL disabled for loopback connection to ${host}`);
      return { host, port, database, user, password, ssl: false as const };
    }
    console.warn(
      `[db] sslmode=disable was requested for non-loopback host "${host}"; ignoring it and keeping SSL required. ` +
        "sslmode=disable is only honored for loopback hosts (localhost/127.0.0.1/::1)."
    );
  }

  return { host, port, database, user, password };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function resolvePgConfig(env: NodeJS.ProcessEnv = process.env): PgConfig | null {
  const host = env.PGHOST;
  const user = env.PGUSER;
  const password = env.PGPASSWORD;

  if (host && user && password) {
    return {
      host,
      port: parseInt(env.PGPORT ?? "6543", 10),
      database: env.PGDATABASE ?? "postgres",
      user,
      password,
    };
  }

  const connectionString = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!connectionString) {
    return null;
  }

  return parseConnectionString(connectionString);
}
