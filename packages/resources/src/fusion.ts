import type { HybridSearchOptions, RetrievalChannel } from '@zhiheng/contracts';
import { fail } from './policy';
export function hybridOptions(value: Partial<HybridSearchOptions> = {}): HybridSearchOptions {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['candidate_depth', 'rrf_k', 'allow_partial', 'dense_min_score', 'lexical_min_score'].includes(k)))
        fail(400, 'INVALID_HYBRID_OPTIONS');
    const integer = (n: unknown, d: number, min: number, max: number) => { const v = n === undefined ? d : n; if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
        fail(400, 'INVALID_HYBRID_OPTIONS'); return v; };
    const score = (n: unknown, d: number, min: number, max: number) => { const v = n === undefined ? d : n; if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
        fail(400, 'INVALID_HYBRID_OPTIONS'); return v; };
    if (value.allow_partial !== undefined && typeof value.allow_partial !== 'boolean')
        fail(400, 'INVALID_HYBRID_OPTIONS');
    return { candidate_depth: integer(value.candidate_depth, 40, 1, 80), rrf_k: integer(value.rrf_k, 60, 1, 200), allow_partial: value.allow_partial ?? false, dense_min_score: score(value.dense_min_score, .25, -1, 1), lexical_min_score: score(value.lexical_min_score, 0, 0, 1000000) };
}
export function reciprocalRankFusion<T>(channels: Array<{
    name: RetrievalChannel;
    items: Array<{
        key: string;
        value: T;
        score: number;
    }>;
}>, k: number) {
    if (!Number.isInteger(k) || k < 1 || k > 200 || channels.some(c => !['dense', 'lexical'].includes(c.name) || c.items.some(i => !i.key || !Number.isFinite(i.score))) || new Set(channels.map(c => c.name)).size !== channels.length)
        fail(400, 'INVALID_RRF_INPUT');
    const combined = new Map<string, {
        key: string;
        value: T;
        score: number;
        ranks: Partial<Record<RetrievalChannel, number>>;
        contributions: Partial<Record<RetrievalChannel, number>>;
        scores: Partial<Record<RetrievalChannel, number>>;
    }>();
    for (const channel of channels) {
        const seen = new Set<string>();
        let rank = 0;
        for (const item of channel.items) {
            if (seen.has(item.key))
                continue;
            seen.add(item.key);
            rank++;
            const contribution = 1 / (k + rank), entry = combined.get(item.key) ?? { key: item.key, value: item.value, score: 0, ranks: {}, contributions: {}, scores: {} };
            entry.score += contribution;
            entry.ranks[channel.name] = rank;
            entry.contributions[channel.name] = contribution;
            entry.scores[channel.name] = item.score;
            combined.set(item.key, entry);
        }
    }
    return [...combined.values()].sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
// Only operational dependency failures may use the other channel. Auth, input, cancellation and integrity errors cannot.
const recoverable = new Set(['SEARCH_NOT_CONFIGURED', 'SEARCH_MODEL_SPACE_UNAVAILABLE', 'VECTOR_STORE_UNAVAILABLE', 'EMBEDDING_UNAVAILABLE', 'EMBEDDING_RATE_LIMIT', 'EMBEDDING_AUTH_FAILED', 'EMBEDDING_REQUEST_REJECTED', 'EMBEDDING_OUTCOME_UNKNOWN', 'OBJECT_STORE_UNAVAILABLE']);
export const canDegrade = (error: {
    status?: number;
    code?: string;
}) => error.status === 503 && recoverable.has(error.code ?? '');
