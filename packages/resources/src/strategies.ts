import type { PoolClient } from 'pg';
import type { IdentityContext, SearchInput } from '@zhiheng/contracts';
import { IndexingStore } from './indexing';
import { kbCaps } from './store';
import { ROLE_ACTIONS, fail } from './policy';
import { requestConfig, strategyConfig, strategyTrace } from './strategy-config';
export class StrategyStore extends IndexingStore {
    protected async resolveSearchInTransaction(c: PoolClient, m: IdentityContext, input: SearchInput): Promise<SearchInput> {
        // Only trusted callers can supply this field; API validators never accept it.
        if (input.strategy_trace)
            return input;
        const config = requestConfig(input);
        if (input.strategy_mode === 'request')
            return { query: input.query, kb_ids: input.kb_ids, ...config, strategy_mode: input.strategy_mode, strategy_trace: strategyTrace(config) };
        const rows = (await c.query(`SELECT s.* FROM knowledge_base k JOIN retrieval_strategy s ON s.tenant_id=k.tenant_id AND s.id=k.active_strategy_id WHERE k.tenant_id=$1 AND k.status='active' AND 'read'=ANY((${kbCaps})::text[]) AND ($4::uuid[] IS NULL OR k.id=ANY($4)) ORDER BY k.id LIMIT 11`, [m.tenant_id, m.membership_id, ROLE_ACTIONS[m.role], input.kb_ids ?? null])).rows;
        if (rows.length && input.kb_ids?.length !== 1)
            fail(422, 'STRATEGY_SCOPE_REQUIRED');
        if (!rows.length)
            return { query: input.query, kb_ids: input.kb_ids, ...config, strategy_mode: input.strategy_mode, strategy_trace: strategyTrace(config) };
        await this.kb(c, m, rows[0].kb_id, 'read');
        const selected = strategyConfig(rows[0].config);
        return { query: input.query, kb_ids: input.kb_ids, ...selected, strategy_mode: 'active', strategy_trace: strategyTrace(selected, rows[0]) };
    }
    protected resolveSearch(current: IdentityContext, input: SearchInput) { return this.run(current, (c, m) => this.resolveSearchInTransaction(c, m, input)); }
}
