import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext } from '@zhiheng/contracts';
import { CorrectionStore } from './corrections';
import { transaction } from './database';
import { docCaps, kbCaps, docEtag, type ListInput } from './store';
import { fail, ROLE_ACTIONS, ResourceError } from './policy';
import { lifecyclePolicy, storageKey } from './lifecycle-policy';
import { DenseIndex } from './dense-index';
import { IndexFailure, type EmbeddingProfile } from './embedding';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const cleanupView = (r: any) => ({ id: r.id, document_id: r.document_id, kb_id: r.kb_id, status: r.status, stage: r.stage, error_code: r.error_code, attempt_count: r.attempt_count, run_no: r.run_no, not_before: r.not_before.toISOString(), created_at: r.created_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null });
class Dependency extends Error {
}
/** PG commits are the access barrier. Remote deletion is durable, bounded and independently retriable. */
export class LifecycleStore extends CorrectionStore {
    private async deletedAccess(c: PoolClient, m: IdentityContext, document: string, management = false) {
        const loc = (await c.query('SELECT kb_id FROM document WHERE tenant_id=$1 AND id=$2', [m.tenant_id, document])).rows[0];
        if (!loc)
            fail(404, 'RESOURCE_UNAVAILABLE');
        await this.kb(c, m, loc.kb_id, undefined);
        const row = (await c.query(`SELECT d.*,${kbCaps} AS kc,${docCaps} AS dc FROM document d JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id WHERE d.tenant_id=$1 AND d.id=$4 FOR SHARE OF d`, [m.tenant_id, m.membership_id, ROLE_ACTIONS[m.role], document])).rows[0];
        const caps = (row.kc ?? []).filter((a: string) => row.acl_mode === 'inherit' || (row.dc ?? []).includes(a));
        if (!caps.includes('read') || !caps.includes(management ? 'manage' : 'delete'))
            fail(404, 'RESOURCE_UNAVAILABLE');
        return row;
    }
    deleteDocument(current: IdentityContext, document: string, etag: string | undefined, key: string, requestId: string) {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
            fail(400, 'IDEMPOTENCY_KEY_REQUIRED');
        return this.run(current, async (c, m) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`delete:${m.tenant_id}:${m.membership_id}:${hash(key)}`]);
            const old = (await c.query('SELECT * FROM deletion_request WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3', [m.tenant_id, m.membership_id, hash(key)])).rows[0];
            if (old) {
                await this.deletedAccess(c, m, old.document_id);
                if (old.document_id !== document)
                    fail(409, 'IDEMPOTENCY_CONFLICT');
                return cleanupView((await c.query('SELECT * FROM document_cleanup WHERE tenant_id=$1 AND id=$2', [m.tenant_id, old.cleanup_id])).rows[0]);
            }
            const doc = await this.doc(c, m, document, 'delete', true);
            if (!etag)
                fail(428, 'IF_MATCH_REQUIRED');
            if (etag !== docEtag(doc))
                fail(412, 'RESOURCE_VERSION_CHANGED');
            await c.query('INSERT INTO document_tombstone(tenant_id,document_id,kb_id,member_id,actor_id,request_id) VALUES($1,$2,$3,$4,$5,$6)', [m.tenant_id, document, doc.kb_id, m.membership_id, m.actor_id, requestId]);
            await c.query("UPDATE document SET status='deleted',published_version_id=NULL,published_generation_id=NULL,row_version=row_version+1,policy_version=policy_version+1 WHERE tenant_id=$1 AND id=$2", [m.tenant_id, document]);
            const jobs = (await c.query("SELECT * FROM ingestion_job WHERE tenant_id=$1 AND document_id=$2 AND status IN ('queued','running','retry_wait','waiting_dependency') ORDER BY id FOR UPDATE", [m.tenant_id, document])).rows;
            for (const job of jobs) {
                if (job.status === 'running' && (await c.query("SELECT 1 FROM ingestion_attempt WHERE tenant_id=$1 AND job_id=$2 AND lease_token=$3 AND write_protocol='legacy'", [m.tenant_id, job.id, job.lease_token])).rowCount)
                    await c.query("INSERT INTO storage_write(tenant_id,id,document_id,job_id,kind,status) VALUES($1,$2,$3,$4,'legacy','unknown')", [m.tenant_id, randomUUID(), document, job.id]);
                await this.endAttempt(c, job, 'cancelled', 'DOCUMENT_DELETED');
                await this.change(c, job, { status: 'cancelled', stage: 'cancelled', cancel_requested_at: new Date(), error_code: 'DOCUMENT_DELETED', dead_letter: false });
            }
            const runs = (await c.query("SELECT * FROM chat_run WHERE tenant_id=$1 AND status='running' AND dependencies @> $2::jsonb ORDER BY id FOR UPDATE", [m.tenant_id, JSON.stringify([{ document_id: document }])])).rows;
            for (const row of runs)
                await this.terminal(c, row, 'failed', 'ACCESS_CHANGED');
            const row = (await c.query("INSERT INTO document_cleanup(tenant_id,id,document_id,kb_id,member_id,status,not_before) VALUES($1,$2,$3,$4,$5,'pending',now()+($6::int*interval '1 hour')) RETURNING *", [m.tenant_id, randomUUID(), document, doc.kb_id, m.membership_id, lifecyclePolicy().retentionHours])).rows[0];
            await c.query('INSERT INTO deletion_request VALUES($1,$2,$3,$4,$5)', [m.tenant_id, m.membership_id, hash(key), document, row.id]);
            await this.cleanupEvent(c, row, 'deleted', m.membership_id);
            await this.audit(c, m, document, 'document.deleted', requestId);
            return cleanupView(row);
        });
    }
    private async cleanupEvent(c: PoolClient, row: any, kind: string, member?: string, error?: string) { await c.query('INSERT INTO cleanup_event(tenant_id,cleanup_id,kind,member_id,error_code) VALUES($1,$2,$3,$4,$5)', [row.tenant_id, row.id, kind, member ?? null, error ?? null]); }
    getCleanup(current: IdentityContext, id: string) { return this.run(current, async (c, m) => { const row = (await c.query('SELECT * FROM document_cleanup WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id])).rows[0]; if (!row)
        fail(404, 'RESOURCE_UNAVAILABLE'); await this.deletedAccess(c, m, row.document_id); const counts = (await c.query('SELECT kind,status,count(*)::int AS count FROM cleanup_item WHERE tenant_id=$1 AND cleanup_id=$2 GROUP BY kind,status', [m.tenant_id, id])).rows; const events = (await c.query('SELECT kind,error_code,created_at FROM cleanup_event WHERE tenant_id=$1 AND cleanup_id=$2 ORDER BY seq DESC LIMIT 50', [m.tenant_id, id])).rows; return { ...cleanupView(row), items: counts, events }; }); }
    listCleanups(current: IdentityContext, kb: string, input: ListInput) {
        return this.run(current, async (c, m) => {
            await this.kb(c, m, kb, 'read');
            const scope = this.scope(m, input, `cleanups:${kb}`), after = this.cursor(input, scope);
            const rows = (await c.query(`SELECT x.* FROM document_cleanup x JOIN document d ON d.tenant_id=x.tenant_id AND d.id=x.document_id JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id WHERE x.tenant_id=$1 AND x.kb_id=$4 AND 'read'=ANY((${kbCaps})::text[]) AND 'delete'=ANY((${kbCaps})::text[]) AND (d.acl_mode='inherit' OR ('read'=ANY((${docCaps})::text[]) AND 'delete'=ANY((${docCaps})::text[]))) AND ($5::timestamptz IS NULL OR (x.created_at,x.id)<($5::timestamptz,$6::uuid)) ORDER BY x.created_at DESC,x.id DESC LIMIT $7`, [m.tenant_id, m.membership_id, ROLE_ACTIONS[m.role], kb, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows;
            const page = this.page(rows, input, scope);
            return { ...page, data: page.data.map(cleanupView) };
        });
    }
    cleanupAction(current: IdentityContext, id: string, action: 'retry' | 'reconcile_writes' | 'bind_legacy', note: string, requestId: string) {
        return this.run(current, async (c, m) => {
            const prior = (await c.query('SELECT * FROM document_cleanup WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id])).rows[0];
            if (!prior)
                fail(404, 'RESOURCE_UNAVAILABLE');
            await this.deletedAccess(c, m, prior.document_id, true);
            const row = (await c.query('SELECT * FROM document_cleanup WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [m.tenant_id, id])).rows[0];
            if (row.status === 'running' || row.status === 'succeeded')
                fail(409, 'CLEANUP_ACTION_UNAVAILABLE');
            if (action === 'reconcile_writes') {
                if ((await c.query("SELECT 1 FROM storage_write WHERE tenant_id=$1 AND document_id=$2 AND (status IN ('unknown','running') OR (storage_key IS NOT NULL AND status<>'reconciled' AND storage_key<>$3)) AND updated_at>now()-interval '5 minutes'", [m.tenant_id, row.document_id, this.objects.storageIdentity ?? ''])).rowCount)
                    fail(409, 'WRITER_DRAIN_REQUIRED');
                await c.query("UPDATE storage_write SET status='reconciled',updated_at=now() WHERE tenant_id=$1 AND document_id=$2 AND (status IN ('unknown','running') OR (storage_key IS NOT NULL AND status<>'reconciled' AND storage_key<>$3))", [m.tenant_id, row.document_id, this.objects.storageIdentity ?? '']);
            }
            else if (action === 'bind_legacy') {
                if (!this.objects.storageIdentity)
                    fail(409, 'OBJECT_STORAGE_BINDING_REQUIRED');
                await c.query('INSERT INTO object_binding(tenant_id,document_id,storage_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [m.tenant_id, row.document_id, this.objects.storageIdentity]);
                if (!process.env.MILVUS_ADDRESS && (await c.query('SELECT 1 FROM index_generation WHERE tenant_id=$1 AND document_id=$2', [m.tenant_id, row.document_id])).rowCount)
                    fail(409, 'VECTOR_ROUTE_REQUIRED');
                await c.query('INSERT INTO vector_binding(tenant_id,generation_id,storage_key) SELECT tenant_id,id,$3 FROM index_generation WHERE tenant_id=$1 AND document_id=$2 ON CONFLICT DO NOTHING', [m.tenant_id, row.document_id, storageKey(process.env.MILVUS_ADDRESS ?? '')]);
            }
            const result = (await c.query("UPDATE document_cleanup SET status='pending',error_code=NULL,next_run_at=now(),attempt_count=0,run_no=run_no+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [m.tenant_id, id])).rows[0];
            await this.cleanupEvent(c, row, action, m.membership_id);
            await this.audit(c, m, row.document_id, `cleanup.${action}:${hash(note)}`, requestId);
            return cleanupView(result);
        });
    }
    private async item(row: any, kind: string, target: object, perform: () => Promise<void>) { const id = hash(JSON.stringify([kind, target])); await this.pool!.query('INSERT INTO cleanup_item(tenant_id,cleanup_id,id,kind,target) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [row.tenant_id, row.id, id, kind, JSON.stringify(target)]); await perform(); await this.pool!.query("UPDATE cleanup_item SET status='done',updated_at=now() WHERE tenant_id=$1 AND cleanup_id=$2 AND id=$3", [row.tenant_id, row.id, id]); }
    private async scrubRuns(c: PoolClient, tenant: string, document?: string) {
        const rows = (await c.query(`SELECT r.* FROM chat_run r JOIN conversation v ON v.tenant_id=r.tenant_id AND v.id=r.conversation_id WHERE r.tenant_id=$1 AND r.content_purged_at IS NULL AND ${document ? "r.dependencies @> $2::jsonb" : "(r.content_expires_at<=now() OR v.deleted_at IS NOT NULL)"} ORDER BY r.id FOR UPDATE OF r`, document ? [tenant, JSON.stringify([{ document_id: document }])] : [tenant])).rows;
        for (const r of rows) {
            await this.terminal(c, r, 'failed', 'HISTORY_EXPIRED');
            await c.query("UPDATE chat_run SET input=$3,result=NULL,dependencies='[]',content_purged_at=now() WHERE tenant_id=$1 AND id=$2", [tenant, r.id, JSON.stringify({ query: '[历史内容已清理]' })]);
            await c.query('DELETE FROM chat_event WHERE tenant_id=$1 AND run_id=$2', [tenant, r.id]);
            await c.query('DELETE FROM chat_feedback WHERE tenant_id=$1 AND run_id=$2', [tenant, r.id]);
            await c.query('INSERT INTO history_purge_log(tenant_id,run_id,reason,document_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tenant, r.id, document ? 'document_deleted' : 'retention', document ?? null]);
        }
        return rows.length;
    }
    async purgeExpiredHistory() { if (!lifecyclePolicy().enabled)
        return 0; return transaction(this.pool, async (c) => { const tenants = (await c.query('SELECT DISTINCT tenant_id FROM chat_run WHERE content_purged_at IS NULL AND (content_expires_at<=now() OR EXISTS(SELECT 1 FROM conversation v WHERE v.tenant_id=chat_run.tenant_id AND v.id=chat_run.conversation_id AND v.deleted_at IS NOT NULL)) LIMIT 20')).rows; let n = 0; for (const t of tenants)
        n += await this.scrubRuns(c, t.tenant_id); return n; }); }
    /** Session advisory lock survives transaction boundaries; a crashed worker releases it automatically. */
    async cleanupTick() {
        if (!lifecyclePolicy().enabled)
            return false;
        const candidates = (await this.pool!.query("SELECT * FROM document_cleanup WHERE status IN ('pending','retry_wait','running') AND not_before<=now() AND next_run_at<=now() ORDER BY created_at LIMIT 20")).rows;
        for (const candidate of candidates) {
            const lock = await this.pool!.connect(), key = `cleanup:${candidate.tenant_id}:${candidate.id}`;
            let held = false;
            try {
                held = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', [key])).rows[0].held;
                if (!held)
                    continue;
                const row = await transaction(this.pool, async (c) => { const r = (await c.query('SELECT * FROM document_cleanup WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [candidate.tenant_id, candidate.id])).rows[0]; if (!['pending', 'retry_wait', 'running'].includes(r.status) || r.not_before > new Date() || r.next_run_at > new Date())
                    return null; await c.query("UPDATE document_cleanup SET status='running',stage='writers',attempt_count=attempt_count+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [r.tenant_id, r.id]); await this.cleanupEvent(c, r, 'started'); return r; });
                if (!row)
                    continue;
                try {
                    await this.performCleanup(row);
                    await transaction(this.pool, async (c) => { await c.query("UPDATE document_cleanup SET status='succeeded',stage='finished',error_code=NULL,finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]); await this.cleanupEvent(c, row, 'succeeded'); });
                }
                catch (error) {
                    const dependency = error instanceof Dependency, code = dependency ? error.message : error instanceof ResourceError || error instanceof IndexFailure ? error.code : 'CLEANUP_UNAVAILABLE';
                    await transaction(this.pool, async (c) => { await c.query("UPDATE document_cleanup SET status=$3,error_code=$4,next_run_at=now()+interval '30 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, dependency ? 'waiting_dependency' : row.attempt_count >= 4 ? 'failed' : 'retry_wait', code]); await this.cleanupEvent(c, row, dependency ? 'blocked' : 'failed', undefined, code); });
                }
                return true;
            }
            finally {
                if (held)
                    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => { });
                lock.release();
            }
        }
        return false;
    }
    private async performCleanup(row: any) {
        const args = [row.tenant_id, row.document_id];
        const binding = (await this.pool!.query('SELECT storage_key FROM object_binding WHERE tenant_id=$1 AND document_id=$2', args)).rows[0];
        if (!this.objects.storageIdentity || binding?.storage_key !== this.objects.storageIdentity)
            throw new Dependency('OBJECT_STORAGE_BINDING_REQUIRED');
        if ((await this.pool!.query("SELECT 1 FROM storage_write WHERE tenant_id=$1 AND document_id=$2 AND storage_key IS NOT NULL AND storage_key<>$3 AND status<>'reconciled'", [...args, this.objects.storageIdentity])).rowCount)
            throw new Dependency('OBJECT_STORAGE_BINDING_REQUIRED');
        if ((await this.pool!.query("SELECT 1 FROM storage_write WHERE tenant_id=$1 AND document_id=$2 AND status IN ('running','unknown')", args)).rowCount)
            throw new Dependency('WRITES_REQUIRE_RECONCILIATION');
        const versions = (await this.pool!.query('SELECT id FROM document_version WHERE tenant_id=$1 AND document_id=$2', args)).rows.map(r => r.id);
        const generations = (await this.pool!.query('SELECT g.*,p.dimension,b.storage_key FROM index_generation g JOIN embedding_profile p ON p.hash=g.profile_hash LEFT JOIN vector_binding b ON b.tenant_id=g.tenant_id AND b.generation_id=g.id WHERE g.tenant_id=$1 AND g.document_id=$2', args)).rows;
        for (const g of generations) {
            if (!process.env.MILVUS_ADDRESS || g.storage_key !== storageKey(process.env.MILVUS_ADDRESS))
                throw new Dependency('VECTOR_STORAGE_BINDING_REQUIRED');
        }
        await this.pool!.query("UPDATE document_cleanup SET stage='vectors' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
        for (const g of generations) {
            const profile = { hash: g.profile_hash, dimension: g.dimension, milvusAddress: process.env.MILVUS_ADDRESS!, milvusToken: process.env.MILVUS_TOKEN, milvusTimeoutMs: 10000 } as EmbeddingProfile;
            const dense = new DenseIndex(profile);
            try {
                await this.item(row, 'vector', { generation_id: g.id, profile_hash: g.profile_hash, storage_key: g.storage_key }, () => dense.erase(row.tenant_id, g.id));
            }
            finally {
                dense.close();
            }
        }
        if (!this.objects.inventory)
            throw new Dependency('OBJECT_INVENTORY_REQUIRED');
        await this.pool!.query("UPDATE document_cleanup SET stage='objects' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
        const sources = (await this.pool!.query(`SELECT DISTINCT a.object_key FROM source_asset a JOIN document_version v ON v.tenant_id=a.tenant_id AND v.source_asset_id=a.id WHERE v.tenant_id=$1 AND v.document_id=$2 AND NOT EXISTS(SELECT 1 FROM document_version other JOIN document d ON d.tenant_id=other.tenant_id AND d.id=other.document_id WHERE other.tenant_id=a.tenant_id AND other.source_asset_id=a.id AND d.status<>'deleted')`, args)).rows;
        const tickets = (await this.pool!.query('SELECT object_key FROM upload_ticket WHERE tenant_id=$1 AND assigned_document_id=$2', args)).rows;
        const shared = (await this.pool!.query("SELECT DISTINCT a.object_key FROM source_asset a JOIN document_version v ON v.tenant_id=a.tenant_id AND v.source_asset_id=a.id JOIN document d ON d.tenant_id=v.tenant_id AND d.id=v.document_id WHERE a.tenant_id=$1 AND d.id<>$2 AND d.status<>'deleted'", args)).rows.map(r => r.object_key);
        const exact = [...new Set([...sources, ...tickets].map(s => s.object_key as string))].filter(k => !shared.includes(k)), prefixes = versions.flatMap(v => [`tenants/${row.tenant_id}/parsed/${v}/`, `tenants/${row.tenant_id}/chunks/${v}/`]);
        const inventory = async () => { const targets: Array<{
            key: string;
            version: string;
        }> = []; for (const prefix of [...exact, ...prefixes])
            for (const item of await this.objects.inventory!(prefix)) {
                if (prefixes.includes(prefix) || item.key === prefix)
                    targets.push(item);
            } return [...new Map(targets.map(t => [JSON.stringify(t), t])).values()]; };
        for (const target of await inventory())
            await this.item(row, 'object', target, () => this.objects.remove(target.key, target.version));
        if ((await inventory()).length)
            throw new Error('Object deletion unconfirmed');
        await this.pool!.query("UPDATE document_cleanup SET stage='metadata' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
        await this.item(row, 'pg', { document_id: row.document_id }, () => transaction(this.pool, async (c) => {
            await this.scrubRuns(c, row.tenant_id, row.document_id);
            await c.query("UPDATE correction_event e SET note='[内容已清理]',content_purged_at=now() FROM correction_case x WHERE x.tenant_id=e.tenant_id AND x.id=e.case_id AND x.tenant_id=$1 AND x.document_id=$2 AND e.content_purged_at IS NULL", args);
            await c.query("UPDATE correction_case SET description='[关联来源已删除，正文已清理]',verification_note=NULL,resolution_note=NULL,closure_evidence=NULL,content_purged_at=now(),row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND document_id=$2 AND content_purged_at IS NULL", args);
            // Cache reservations and deletion share the same tenant/profile lock. Preserve any other live reference.
            const profiles = (await c.query('SELECT DISTINCT profile_hash FROM index_generation WHERE tenant_id=$1 AND document_id=$2 ORDER BY profile_hash', args)).rows;
            for (const p of profiles) {
                await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [row.tenant_id + p.profile_hash]);
                await c.query(`DELETE FROM embedding_entry e WHERE e.tenant_id=$1 AND e.profile_hash=$2 AND e.text_sha256 IN (SELECT retrieval_sha256 FROM knowledge_chunk WHERE tenant_id=$1 AND version_id=ANY($3::uuid[])) AND NOT EXISTS(SELECT 1 FROM knowledge_chunk k JOIN index_generation g ON g.tenant_id=k.tenant_id AND g.version_id=k.version_id JOIN document d ON d.tenant_id=g.tenant_id AND d.id=g.document_id WHERE k.tenant_id=e.tenant_id AND k.retrieval_sha256=e.text_sha256 AND g.profile_hash=e.profile_hash AND d.status<>'deleted')`, [row.tenant_id, p.profile_hash, versions]);
            }
            await c.query('DELETE FROM ingestion_checkpoint WHERE tenant_id=$1 AND job_id IN (SELECT id FROM ingestion_job WHERE tenant_id=$1 AND document_id=$2)', args);
            await c.query('DELETE FROM index_receipt WHERE tenant_id=$1 AND generation_id IN (SELECT id FROM index_generation WHERE tenant_id=$1 AND document_id=$2)', args);
            await c.query('DELETE FROM vector_binding WHERE tenant_id=$1 AND generation_id IN (SELECT id FROM index_generation WHERE tenant_id=$1 AND document_id=$2)', args);
            await c.query('DELETE FROM index_generation WHERE tenant_id=$1 AND document_id=$2', args);
            for (const table of ['chunk_source', 'knowledge_chunk', 'chunk_manifest', 'parsed_block', 'parsed_document'])
                await c.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND version_id=ANY($2::uuid[])`, [row.tenant_id, versions]);
            await c.query("UPDATE source_asset a SET filename='[已清理]',content_purged_at=now() WHERE a.tenant_id=$1 AND a.content_purged_at IS NULL AND a.id IN (SELECT source_asset_id FROM document_version WHERE tenant_id=$1 AND document_id=$2) AND NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.tenant_id=v.tenant_id AND d.id=v.document_id WHERE v.tenant_id=a.tenant_id AND v.source_asset_id=a.id AND d.status<>'deleted')", args);
            await c.query("UPDATE document SET title='[已删除文档]' WHERE tenant_id=$1 AND id=$2", args);
            await c.query("UPDATE upload_ticket SET filename='[已清理]' WHERE tenant_id=$1 AND assigned_document_id=$2", args);
        }));
    }
}
