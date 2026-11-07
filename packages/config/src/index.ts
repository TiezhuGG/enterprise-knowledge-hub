function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return parsed;
}
export function apiConfig(env: NodeJS.ProcessEnv = process.env) {
  return { host: env.API_HOST ?? '127.0.0.1', port: port(env.API_PORT, 3000) };
}
export function redisConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: env.REDIS_HOST ?? '127.0.0.1',
    port: port(env.REDIS_PORT, 6379),
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  };
}

export function authConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.DEV_AUTH_ENABLED === 'true';
  if (env.DEV_AUTH_ENABLED && !['true', 'false'].includes(env.DEV_AUTH_ENABLED)) {
    throw new Error('DEV_AUTH_ENABLED must be true or false');
  }
  if (enabled && !['development', 'test'].includes(env.NODE_ENV ?? '')) {
    throw new Error('Development authentication requires development or test mode');
  }
  if (enabled && (env.DEV_AUTH_SECRET?.length ?? 0) < 32) {
    throw new Error('DEV_AUTH_SECRET requires at least 32 characters');
  }
  const ttl = Number(env.SESSION_TTL_SECONDS ?? 28800);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error('Invalid session TTL');
  const origin = env.AUTH_ORIGIN ?? 'http://127.0.0.1:5173';
  if (new URL(origin).origin !== origin) throw new Error('AUTH_ORIGIN must be an exact origin');
  const prefix = env.AUTH_REDIS_PREFIX ?? 'zhiheng:auth:';
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(prefix)) throw new Error('Invalid auth Redis prefix');
  return { enabled, secret: env.DEV_AUTH_SECRET ?? '', ttl, origin, prefix,
    disabledAccounts: (env.DEV_DISABLED_ACCOUNTS ?? '').split(',') };
}
