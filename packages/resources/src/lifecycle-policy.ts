import { createHash } from 'node:crypto';
export function lifecyclePolicy(env: NodeJS.ProcessEnv = process.env) {
    const number = (key: string, fallback: number, min: number, max: number) => { const n = Number(env[key] ?? fallback); if (!Number.isInteger(n) || n < min || n > max)
        throw new Error(`Invalid ${key}`); return n; };
    if (env.LIFECYCLE_CLEANUP_ENABLED !== undefined && !['true', 'false'].includes(env.LIFECYCLE_CLEANUP_ENABLED))
        throw new Error('Invalid LIFECYCLE_CLEANUP_ENABLED');
    return { enabled: env.LIFECYCLE_CLEANUP_ENABLED === 'true', retentionHours: number('LIFECYCLE_DELETE_RETENTION_HOURS', 168, 0, 87600), historyDays: number('CHAT_HISTORY_RETENTION_DAYS', 30, 1, 3650), pollMs: number('LIFECYCLE_POLL_MS', 1000, 100, 60000) };
}
export const storageKey = (address: string) => createHash('sha256').update(address.trim()).digest('hex');
