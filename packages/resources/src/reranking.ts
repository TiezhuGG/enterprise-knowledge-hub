import { createHash } from 'node:crypto';
import type { RerankOptions, ContextOptions } from '@zhiheng/contracts';
import { fail } from './policy';
export interface RerankProfile {
    endpoint: string;
    model: string;
    revision: string;
    hash: string;
    timeoutMs: number;
    key?: string;
}
export class RerankFailure extends Error {
    constructor(readonly code: string) { super(code); }
}
export function rerankProfile(env: NodeJS.ProcessEnv = process.env): RerankProfile | null {
    if (env.RERANK_ENABLED !== undefined && !['true', 'false'].includes(env.RERANK_ENABLED))
        throw new Error('Invalid RERANK_ENABLED');
    if (env.RERANK_ENABLED !== 'true')
        return null;
    const url = new URL(env.RERANK_BASE_URL ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
        throw new Error('Reranking requires loopback endpoint');
    const model = env.RERANK_MODEL ?? 'bge-reranker-v2-m3', revision = env.RERANK_REVISION ?? '', timeoutMs = Number(env.RERANK_TIMEOUT_MS ?? 2000), endpoint = url.href.replace(/\/+$/, '');
    if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model) || !revision.trim() || revision.length > 200 || /[\r\n]/.test(revision) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
        throw new Error('Incomplete rerank profile');
    return { endpoint, model, revision, timeoutMs, key: env.RERANK_API_KEY, hash: createHash('sha256').update(JSON.stringify([endpoint, model, revision, 'rerank-v1'])).digest('hex') };
}
function integer(v: unknown, d: number, min: number, max: number) { const n = v === undefined ? d : v; if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    fail(400, 'INVALID_RERANK_OPTIONS'); return n; }
export function rerankOptions(v: Partial<RerankOptions> = {}): RerankOptions {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['enabled', 'top_n', 'max_input_characters', 'failure_policy'].includes(k)) || v.enabled !== undefined && typeof v.enabled !== 'boolean' || v.failure_policy !== undefined && !['fusion', 'fail'].includes(v.failure_policy))
        fail(400, 'INVALID_RERANK_OPTIONS');
    return { enabled: v.enabled ?? false, top_n: integer(v.top_n, 15, 1, 40), max_input_characters: integer(v.max_input_characters, 1000, 64, 1600), failure_policy: v.failure_policy ?? 'fusion' };
}
export function contextOptions(v: Partial<ContextOptions> = {}): ContextOptions { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => k !== 'max_per_document'))
    fail(400, 'INVALID_CONTEXT_OPTIONS'); return { max_per_document: integer(v.max_per_document, 20, 1, 20) }; }
export function rerankInputs(texts: string[], limit: number) { return texts.map(text => { const points = Array.from(text); return { text: points.slice(0, limit).join(''), truncated: points.length > limit }; }); }
export function validateRerank(value: any, count: number, profile: RerankProfile): {
    rows: Array<{
        index: number;
        score: number;
    }>;
    tokens: number | null;
} {
    if (value?.model !== profile.model || value?.revision !== profile.revision)
        throw new RerankFailure('RERANK_MODEL_MISMATCH');
    if (!Array.isArray(value.results) || value.results.length !== count)
        throw new RerankFailure('RERANK_INVALID_RESPONSE');
    const seen = new Set<number>();
    const rows = value.results.map((r: any) => { if (!Number.isInteger(r.index) || r.index < 0 || r.index >= count || seen.has(r.index) || typeof r.relevance_score !== 'number' || !Number.isFinite(r.relevance_score) || Math.abs(r.relevance_score) > 1000000)
        throw new RerankFailure('RERANK_INVALID_RESPONSE'); seen.add(r.index); return { index: r.index, score: r.relevance_score }; });
    const tokens = value.usage?.total_tokens ?? null;
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0))
        throw new RerankFailure('RERANK_INVALID_RESPONSE');
    return { rows: rows.sort((a: {
            index: number;
            score: number;
        }, b: {
            index: number;
            score: number;
        }) => b.score - a.score || a.index - b.index), tokens };
}
export async function rerank(profile: RerankProfile, query: string, documents: string[], signal: AbortSignal) {
    if (!documents.length || documents.length > 40 || query.length > 1200 || documents.some(d => Array.from(d).length > 1600))
        throw new RerankFailure('RERANK_INPUT_LIMIT');
    const timeout = AbortSignal.timeout(profile.timeoutMs), combined = AbortSignal.any([signal, timeout]);
    try {
        const response = await fetch(`${profile.endpoint}/rerank`, { method: 'POST', redirect: 'error', signal: combined, headers: { 'Content-Type': 'application/json', ...(profile.key ? { Authorization: `Bearer ${profile.key}` } : {}) }, body: JSON.stringify({ model: profile.model, revision: profile.revision, query, documents, top_n: documents.length, return_documents: false }) });
        if (!response.ok) {
            await response.body?.cancel();
            throw new RerankFailure('RERANK_UNAVAILABLE');
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new RerankFailure('RERANK_INVALID_RESPONSE');
        let size = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
            const p = await reader.read();
            if (p.done)
                break;
            size += p.value.length;
            if (size > 262144) {
                await reader.cancel();
                throw new RerankFailure('RERANK_INVALID_RESPONSE');
            }
            chunks.push(p.value);
        }
        let value;
        try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            throw new RerankFailure('RERANK_INVALID_RESPONSE');
        }
        return validateRerank(value, documents.length, profile);
    }
    catch (error) {
        if (signal.aborted)
            fail(408, 'SEARCH_CANCELLED');
        if (timeout.aborted)
            throw new RerankFailure('RERANK_TIMEOUT');
        if (error instanceof RerankFailure)
            throw error;
        throw new RerankFailure('RERANK_UNAVAILABLE');
    }
}
