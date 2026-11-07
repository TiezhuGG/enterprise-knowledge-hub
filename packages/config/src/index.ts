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
