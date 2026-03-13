type PgConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
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

  if (!host || !user || !password || Number.isNaN(port)) {
    return null;
  }

  return {
    host,
    port,
    database,
    user,
    password,
  };
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
