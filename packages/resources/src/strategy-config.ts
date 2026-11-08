import type { SearchInput, StrategyTrace } from '@zhiheng/contracts';
import { hybridOptions } from './fusion';
import { contextOptions, rerankOptions } from './reranking';
import { fail } from './policy';
import { digest } from './embedding';
export type StrategyConfig = Omit<SearchInput, 'query' | 'kb_ids' | 'strategy_mode' | 'strategy_trace'>;
export function strategyConfig(raw: unknown = {}): StrategyConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['mode', 'top_k', 'min_score', 'max_characters', 'hybrid', 'rerank', 'context'].includes(k)))
        fail(400, 'INVALID_STRATEGY_CONFIG');
    const b = raw as Record<string, any>, mode = b.mode ?? 'dense';
    if (!['dense', 'lexical', 'hybrid'].includes(mode))
        fail(400, 'INVALID_STRATEGY_CONFIG');
    const int = (v: any, d: number, min: number, max: number) => { v ??= d; if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
        fail(400, 'INVALID_STRATEGY_CONFIG'); return v; };
    if (mode !== 'hybrid' && (b.hybrid !== undefined || b.rerank !== undefined))
        fail(400, 'INVALID_STRATEGY_CONFIG');
    if(mode==='hybrid'&&b.min_score!==undefined&&b.min_score!==.25)fail(400,'HYBRID_USE_CHANNEL_THRESHOLDS');const score = b.min_score ?? (mode === 'lexical' ? 0 : .25);
    if (typeof score !== 'number' || !Number.isFinite(score) || score < (mode === 'lexical' ? 0 : -1) || score > (mode === 'lexical' ? 1000000 : 1))
        fail(400, 'INVALID_STRATEGY_CONFIG');
    return { mode, top_k: int(b.top_k, 5, 1, 20), min_score: score, max_characters: int(b.max_characters, 6000, 500, 16000), context: contextOptions(b.context), ...(mode === 'hybrid' ? { hybrid: hybridOptions(b.hybrid), rerank: rerankOptions(b.rerank) } : {}) };
}
export function requestConfig(input: SearchInput) { return strategyConfig({ mode: input.mode, top_k: input.top_k, min_score: input.mode==='hybrid'?.25:input.min_score, max_characters: input.max_characters, ...(input.hybrid ? { hybrid: input.hybrid } : {}), ...(input.rerank ? { rerank: input.rerank } : {}), ...(input.context ? { context: input.context } : {}) }); }
export function strategyTrace(config: StrategyConfig, row?: any): StrategyTrace { return { config,id: row?.id ?? null, version: row?.version_no ?? null, config_hash: digest(JSON.stringify(config)), source: row ? 'published' : 'request' }; }
