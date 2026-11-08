import { embeddingProfile, type EmbeddingProfile } from './embedding';
const fields = ['BASE_URL', 'MODEL', 'REVISION', 'DIMENSION', 'PROCESSING', 'QUERY_PREFIX', 'DOCUMENT_PREFIX', 'BATCH_SIZE', 'TIMEOUT_MS', 'COST_PER_MILLION', 'API_KEY'] as const;
// Values are environment-variable prefixes, never endpoints or credentials supplied by an API caller.
export function indexProfiles(env: NodeJS.ProcessEnv = process.env) {
    const result = new Map<string, EmbeddingProfile>();
    const primary = embeddingProfile(env);
    if (primary)
        result.set('default', primary);
    let aliases: unknown;
    try {
        aliases = JSON.parse(env.EMBEDDING_PROFILES_JSON ?? '{}');
    }
    catch {
        throw new Error('Invalid EMBEDDING_PROFILES_JSON');
    }
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.keys(aliases).length > 8)
        throw new Error('Invalid embedding profiles');
    for (const [name, prefix] of Object.entries(aliases)) {
        if (name === 'default' || !/^[a-zA-Z0-9_-]{1,40}$/.test(name) || typeof prefix !== 'string' || !/^[_A-Z][_A-Z0-9]{0,60}$/.test(prefix))
            throw new Error('Invalid embedding profile alias');
        const config: NodeJS.ProcessEnv = { ...env, INDEX_ENABLED: 'true' };
        for (const field of fields) {
            delete config[`EMBEDDING_${field}`];
            if (env[`${prefix}_${field}`] !== undefined)
                config[`EMBEDDING_${field}`] = env[`${prefix}_${field}`];
        }
        config.EMBEDDING_ALLOW_REMOTE = env[`${prefix}_ALLOW_REMOTE`] ?? 'false';
        const p = embeddingProfile(config)!;
        result.set(name, p);
    }
    return result;
}
export function indexProfile(ref: string, env: NodeJS.ProcessEnv = process.env) { const p = indexProfiles(env).get(ref); if (!p)
    throw new Error('INDEX_PROFILE_UNAVAILABLE'); return p; }
export function indexProfileHash(hash: string, env: NodeJS.ProcessEnv = process.env) { const p = [...indexProfiles(env).values()].find(p => p.hash === hash); if (!p)
    throw new Error('INDEX_PROFILE_UNAVAILABLE'); return p; }
