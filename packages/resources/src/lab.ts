import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext, SearchInput, SearchResponse } from '@zhiheng/contracts';
import { ReleaseStore } from './releases';
import { fail, ResourceError } from './policy';
import { kbEtag, type ListInput } from './store';
import { strategyConfig, strategyTrace, type StrategyConfig } from './strategy-config';
import { digest } from './embedding';
import { rerankProfile } from './reranking';
import { LEXICAL_VERSION, DICTIONARY_HASH } from './lexical';
import { indexProfileHash } from './index-profiles';
export interface LabProbe {
    query: string;
    expected_document_ids: string[];
}
const versionView = (r: any) => ({ id: r.id, kb_id: r.kb_id, version: r.version_no, name: r.name, config: r.config, config_hash: r.config_hash, created_at: r.created_at });
const summary = (r: SearchResponse, ms: number) => ({ strategy: r.meta.strategy, meta: r.meta, duration_ms: ms, evidence: r.data.map(e => ({ document_id: e.document_id, version_id: e.version_id, generation_id: e.generation_id, chunk_id: e.chunk_id, rank: e.rank, score: e.score, retrieval: e.retrieval, rerank: e.rerank })) });
export class LabStore extends ReleaseStore {
    private async labPermission(c: PoolClient, m: IdentityContext, kb: string, publish = false, lock = false) { const k = await this.kb(c, m, kb, 'manage', lock); if (!k.capabilities.includes('read') || (publish && !['write', 'publish'].every(a => k.capabilities.includes(a as never))))
        fail(404, 'RESOURCE_UNAVAILABLE'); return k; }
    private async labVersion(c: PoolClient, m: IdentityContext, id: string,publish=false,lock=false) { const r = (await c.query('SELECT * FROM retrieval_strategy WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id])).rows[0]; if (!r)
        fail(404, 'RESOURCE_UNAVAILABLE'); await this.labPermission(c, m, r.kb_id,publish,lock); return r; }
    private async labRequest(c: PoolClient, m: IdentityContext, key: string, payload: unknown) { if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key))
        fail(400, 'IDEMPOTENCY_KEY_REQUIRED'); const kh = digest(key), ph = digest(JSON.stringify(payload)); await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`strategy:${m.tenant_id}:${m.membership_id}:${kh}`]); const old = (await c.query('SELECT * FROM strategy_request WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0]; if (old && old.payload_hash !== ph)
        fail(409, 'IDEMPOTENCY_CONFLICT'); return { kh, ph, old: old?.result }; }
    private async labRemember(c: PoolClient, m: IdentityContext, key: any, result: any) { await c.query('INSERT INTO strategy_request VALUES($1,$2,$3,$4,$5)', [m.tenant_id, m.membership_id, key.kh, key.ph, JSON.stringify(result)]); return result; }
    private async baseline(c: PoolClient, m: IdentityContext, kb: string) { await this.labPermission(c, m, kb); const row = (await c.query('SELECT s.* FROM knowledge_base k JOIN retrieval_strategy s ON s.tenant_id=k.tenant_id AND s.id=k.active_strategy_id WHERE k.tenant_id=$1 AND k.id=$2', [m.tenant_id, kb])).rows[0]; const config = strategyConfig(row?.config ?? {}); return { row: row ?? null, config, hash: digest(JSON.stringify(config)) }; }
    protected async labFingerprint(c: PoolClient, m: IdentityContext, kb: string) { await this.labPermission(c, m, kb); const targets = await this.eligible(c, m, [kb]); if (targets.length > 50)
        fail(422, 'LAB_SCOPE_TOO_LARGE'); const scope = []; let count = 0; for (const t of targets) {
        const d = await this.doc(c, m, t.document_id, 'read'), receipts = (await c.query('SELECT chunk_id,retrieval_sha256 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 ORDER BY chunk_id', [m.tenant_id, t.generation_id])).rows;
        count += receipts.length;
        if (count > 5000)
            fail(422, 'LAB_SCOPE_TOO_LARGE');
        scope.push({ document_id: t.document_id, version_id: t.version_id, generation_id: t.generation_id, profile_hash: t.profile_hash, row_version: d.row_version, policy_version: d.policy_version, kb_policy_version: d.kb_policy_version, receipts_hash: digest(JSON.stringify(receipts)) });
    } let model: string | null = null; try {
        model = rerankProfile()?.hash ?? null;
        for (const t of targets)
            indexProfileHash(t.profile_hash);
    }
    catch {
        fail(503, 'LAB_MODEL_CONFIG_UNAVAILABLE');
    } return { hash: digest(JSON.stringify([m.membership_id, m.role, (m as any).authz_version, scope, model, LEXICAL_VERSION, DICTIONARY_HASH])), scope }; }
    activeStrategy(current: IdentityContext, kb: string) { return this.run(current, async (c, m) => { const k = await this.kb(c, m, kb, 'read'), row = (await c.query('SELECT s.* FROM knowledge_base k JOIN retrieval_strategy s ON s.tenant_id=k.tenant_id AND s.id=k.active_strategy_id WHERE k.tenant_id=$1 AND k.id=$2', [m.tenant_id, kb])).rows[0]; return { strategy: row ? versionView(row) : null, etag: kbEtag(k) }; }); }
    listStrategies(current: IdentityContext, kb: string, input: ListInput) { return this.run(current, async (c, m) => { await this.labPermission(c, m, kb); const scope = super.scope(m, input, `strategies:${kb}`), after = this.cursor(input, scope), rows = (await c.query('SELECT * FROM retrieval_strategy WHERE tenant_id=$1 AND kb_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5', [m.tenant_id, kb, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows, p = this.page(rows, input, scope); return { ...p, data: p.data.map(versionView) }; }); }
    createStrategy(current: IdentityContext, kb: string, name: string, raw: unknown, key: string, requestId: string) { const config = strategyConfig(raw); if (typeof name !== 'string' || !name.trim() || name.length > 100)
        fail(400, 'INVALID_STRATEGY_NAME'); return this.run(current, async (c, m) => { const req = await this.labRequest(c, m, key, ['create', kb, name.trim(), config]); await this.labPermission(c, m, kb, false, true); if (req.old)
        return req.old; const row = (await c.query('INSERT INTO retrieval_strategy(tenant_id,id,kb_id,version_no,name,config,config_hash,creator_id) SELECT $1,$2,$3,COALESCE(max(version_no),0)+1,$4,$5,$6,$7 FROM retrieval_strategy WHERE tenant_id=$1 AND kb_id=$3 RETURNING *', [m.tenant_id, randomUUID(), kb, name.trim(), JSON.stringify(config), digest(JSON.stringify(config)), m.membership_id])).rows[0]; await this.audit(c, m, kb, 'retrieval_strategy.created', requestId); return this.labRemember(c, m, req, versionView(row)); }); }
    listExperiments(current: IdentityContext, kb: string, input: ListInput) { return this.run(current, async (c, m) => { await this.labPermission(c, m, kb); const scope = super.scope(m, input, `experiments:${kb}`), after = this.cursor(input, scope), rows = (await c.query('SELECT id,created_at,candidate_id,status,error_code,expires_at FROM retrieval_experiment WHERE tenant_id=$1 AND kb_id=$2 AND member_id=$3 AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6', [m.tenant_id, kb, m.membership_id, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows; return this.page(rows, input, scope); }); }
    getExperiment(current: IdentityContext, id: string) { return this.run(current, async (c, m) => { const r = (await c.query('SELECT * FROM retrieval_experiment WHERE tenant_id=$1 AND id=$2 AND member_id=$3', [m.tenant_id, id, m.membership_id])).rows[0]; if (!r)
        fail(404, 'RESOURCE_UNAVAILABLE'); await this.labPermission(c, m, r.kb_id); if (r.status === 'running' && r.created_at.getTime() < Date.now() - 120000) {
        await c.query("UPDATE retrieval_experiment SET status='failed',error_code='LAB_EXECUTION_INTERRUPTED' WHERE tenant_id=$1 AND id=$2 AND status='running'", [m.tenant_id, id]);
        r.status = 'failed';
        r.error_code = 'LAB_EXECUTION_INTERRUPTED';
    } if (r.status === 'completed' && (await this.labFingerprint(c, m, r.kb_id)).hash !== r.scope_hash)
        fail(409, 'LAB_SCOPE_CHANGED'); return { id: r.id, kb_id: r.kb_id, candidate_id: r.candidate_id, baseline_id: r.baseline_id, status: r.status, error_code: r.error_code, expired: r.expires_at < new Date(), report: r.status==='completed'&&r.expires_at > new Date() ? r.report : null, created_at: r.created_at, expires_at: r.expires_at }; }); }
    async runExperiment(current: IdentityContext, candidate: string, probes: LabProbe[], key: string, requestId: string, signal = AbortSignal.timeout(120000)) {
        if (!Array.isArray(probes) || !probes.length || probes.length > 10 || probes.some(p => typeof p.query !== 'string' || !p.query.trim() || p.query.length > 1200 || !Array.isArray(p.expected_document_ids) || p.expected_document_ids.length > 5 || p.expected_document_ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) || new Set(p.expected_document_ids).size !== p.expected_document_ids.length))
            fail(400, 'INVALID_LAB_PROBES');
        const start = await this.run(current, async (c, m) => { const req = await this.labRequest(c, m, key, ['experiment', candidate, probes]), version = await this.labVersion(c, m, candidate); if (req.old)
            return { replay: req.old }; const base = await this.baseline(c, m, version.kb_id), scope = await this.labFingerprint(c, m, version.kb_id);if(!scope.scope.length)fail(409,'LAB_NO_PUBLISHED_DOCUMENTS'); if (probes.some(p => p.expected_document_ids.some(id => !scope.scope.some(d => d.document_id === id))))
            fail(400, 'PROBE_OUTSIDE_SCOPE'); const row = (await c.query('INSERT INTO retrieval_experiment(tenant_id,id,kb_id,member_id,candidate_id,baseline_id,scope_hash,baseline_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [m.tenant_id, randomUUID(), version.kb_id, m.membership_id, version.id, base.row?.id ?? null, scope.hash, base.hash, '{}'])).rows[0]; await this.labRemember(c, m, req, { id: row.id }); await this.audit(c, m, version.kb_id, 'retrieval_experiment.started', requestId); return { row, version, base, scope }; });
        if (start.replay)
            return this.getExperiment(current, start.replay.id);
        const row = start.row!, version = start.version!, base = start.base!, scope = start.scope!;
        const rows: Array<{
            query_hash: string;
            expected_document_ids: string[];
            baseline: ReturnType<typeof summary> & {
                recall: number;
                mrr: number;
            };
            candidate: ReturnType<typeof summary> & {
                recall: number;
                mrr: number;
            };
        }> = [];
        try {
            for (const p of probes) {
                if (signal.aborted)
                    fail(408, 'LAB_CANCELLED');
                const make = (config: StrategyConfig, v?: any): SearchInput => ({ query: p.query, kb_ids: [version.kb_id], ...config, strategy_mode: 'request', strategy_trace: { ...strategyTrace(config, v), source: 'experiment' } });
                const began = Date.now(), before = await this.search(current, make(base.config, base.row), signal), elapsed = Date.now() - began, second = Date.now(), after = await this.search(current, make(strategyConfig(version.config), version), signal);
                const metric = (r: SearchResponse) => { const ids = r.data.map(e => e.document_id), ranks = p.expected_document_ids.map(id => ids.indexOf(id) + 1).filter(n => n > 0); return { recall: p.expected_document_ids.length ? ranks.length / p.expected_document_ids.length : Number(!ids.length), mrr: p.expected_document_ids.length ? (ranks.length ? 1 / Math.min(...ranks) : 0) : Number(!ids.length) }; };
                rows.push({ query_hash: digest(p.query), expected_document_ids: p.expected_document_ids, baseline: { ...summary(before, elapsed), ...metric(before) }, candidate: { ...summary(after, Date.now() - second), ...metric(after) } });
            }
            const metrics = (side: 'baseline' | 'candidate') => ({ recall: rows.reduce((n, r) => n + r[side].recall, 0) / rows.length, mrr: rows.reduce((n, r) => n + r[side].mrr, 0) / rows.length, duration_ms: rows.reduce((n, r) => n + r[side].duration_ms, 0), degraded: rows.some(r => r[side].meta.degraded) }), old = metrics('baseline'), next = metrics('candidate'), report = { rows, baseline: old, candidate: next, positive_samples:probes.filter(p=>p.expected_document_ids.length>0).length,passed: probes.some(p=>p.expected_document_ids.length>0)&&!old.degraded && !next.degraded && next.recall >= old.recall && next.mrr >= old.mrr, sample_count: rows.length };
            await this.run(current, async (c, m) => { await this.labPermission(c, m, version.kb_id); if (signal.aborted)
                fail(408, 'LAB_CANCELLED'); if ((await this.labFingerprint(c, m, version.kb_id)).hash !== scope.hash)
                fail(409, 'LAB_SCOPE_CHANGED'); const active = await this.baseline(c, m, version.kb_id); if (active.row?.id !== base.row?.id || active.hash !== base.hash)
                fail(409, 'LAB_BASELINE_CHANGED'); const saved = await c.query("UPDATE retrieval_experiment SET status='completed',report=$3 WHERE tenant_id=$1 AND id=$2 AND status='running' AND created_at>now()-interval '2 minutes'", [m.tenant_id, row.id, JSON.stringify(report)]); if (!saved.rowCount)
                fail(409, 'LAB_EXECUTION_INTERRUPTED'); await this.audit(c, m, version.kb_id, 'retrieval_experiment.completed', requestId); });
            return this.getExperiment(current, row.id);
        }
        catch (e) {
            await this.pool!.query("UPDATE retrieval_experiment SET status='failed',error_code=$3 WHERE tenant_id=$1 AND id=$2 AND status='running'", [current.tenant_id, row.id, e instanceof ResourceError ? e.code : 'LAB_FAILED']).catch(() => { });
            throw e;
        }
    }
    publishStrategy(current: IdentityContext, id: string, experiment: string, etag: string | undefined, key: string, note: string, reviewed: boolean, requestId: string) { if (reviewed !== true || typeof note !== 'string' || note.trim().length < 10 || note.length > 2000)
        fail(400, 'STRATEGY_REVIEW_REQUIRED'); return this.run(current, async (c, m) => { const req = await this.labRequest(c, m, key, ['activate', id, experiment, digest(note.trim())]), version = await this.labVersion(c, m, id,true,true), k = await this.labPermission(c, m, version.kb_id, true, true); if (req.old)
        return req.old; if (!etag)
        fail(428, 'IF_MATCH_REQUIRED'); if (etag !== kbEtag(k))
        fail(412, 'RESOURCE_VERSION_CHANGED'); const r = (await c.query("SELECT * FROM retrieval_experiment WHERE tenant_id=$1 AND id=$2 AND member_id=$3 AND candidate_id=$4 AND status='completed' AND expires_at>now()", [m.tenant_id, experiment, m.membership_id, id])).rows[0]; if (!r || !r.report.passed || !(r.report.positive_samples>0))
        fail(409, 'STRATEGY_EVALUATION_REQUIRED'); if ((await this.labFingerprint(c, m, version.kb_id)).hash !== r.scope_hash)
        fail(409, 'LAB_SCOPE_CHANGED'); const base = await this.baseline(c, m, version.kb_id); if (base.row?.id !== (r.baseline_id ?? undefined) || base.hash !== r.baseline_hash)
        fail(409, 'LAB_BASELINE_CHANGED'); await c.query('UPDATE knowledge_base SET active_strategy_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2', [m.tenant_id, version.kb_id, id]); await c.query('INSERT INTO strategy_publication(tenant_id,kb_id,member_id,from_id,to_id,experiment_id,review_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [m.tenant_id, version.kb_id, m.membership_id, base.row?.id ?? null, id, experiment, digest(note.trim())]); await this.audit(c, m, version.kb_id, 'retrieval_strategy.published', requestId); return this.labRemember(c, m, req, { strategy: versionView(version), etag: kbEtag({ ...k, row_version: k.row_version + 1 }) }); }); }
    async experimentSource(current: IdentityContext, id: string, row: number, side: 'baseline' | 'candidate', ordinal: number) { if (!Number.isInteger(row) || row < 0 || row > 9 || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 19)
        fail(400, 'INVALID_LAB_SOURCE'); const run = await this.getExperiment(current, id); if (run.status !== 'completed' || run.expired)
        fail(409, 'LAB_REPORT_UNAVAILABLE'); const e = run.report?.rows?.[row]?.[side]?.evidence?.[ordinal]; if (!e)
        fail(404, 'RESOURCE_UNAVAILABLE'); const chunk = await this.getChunk(current, e.document_id, e.version_id, e.chunk_id); const fresh = await this.getExperiment(current, id); if (fresh.expired || fresh.status !== 'completed')
        fail(409, 'LAB_REPORT_UNAVAILABLE'); return chunk; }
    strategyHistory(current: IdentityContext, kb: string, input: ListInput) { return this.run(current, async (c, m) => { await this.labPermission(c, m, kb); const scope = super.scope(m, input, `strategy-history:${kb}`), after = this.cursor(input, scope), rows = (await c.query('SELECT p.*,s.version_no AS version,s.name FROM strategy_publication p LEFT JOIN retrieval_strategy s ON s.tenant_id=p.tenant_id AND s.id=p.to_id WHERE p.tenant_id=$1 AND p.kb_id=$2 AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT $5', [m.tenant_id, kb, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows; return this.page(rows, input, scope); }); }
}
