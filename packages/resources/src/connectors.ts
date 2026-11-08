import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext } from '@zhiheng/contracts';
import { LifecycleStore } from './lifecycle';
import { transaction } from './database';
import { fail, ResourceError } from './policy';
import { docEtag, type ListInput } from './store';
import { DirectorySource, sourceBinding, sourceHash, SourceFailure, connectorSettings, type SourceBinding, type SourceEvent, type SourceSnapshot } from './directory-source';
const keyHash = (v: string) => {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(v))
        fail(400, 'IDEMPOTENCY_KEY_REQUIRED');
    return sourceHash(v);
};
const connectorView = (r: any) => ({ id: r.id, kb_id: r.kb_id, type: 'directory-feed', config_ref: r.config_ref, credential: '服务器配置（不返回密钥）', status: r.status, cursor: Number(r.cursor), observed_end: Number(r.observed_end), row_version: r.row_version, next_poll_at: r.next_poll_at, created_at: r.created_at, updated_at: r.updated_at });
const runView = (r: any) => ({ id: r.id, connector_id: r.connector_id, mode: r.mode, status: r.status, attempts: r.attempts, error_code: r.error_code, pages: r.pages, applied: r.applied, next_run_at: r.next_run_at, created_at: r.created_at, finished_at: r.finished_at });
export class ConnectorStore extends LifecycleStore {
    private async connectorScope(c: PoolClient, m: IdentityContext, id: string, write = false) {
        const row = (await c.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id])).rows[0];
        if (!row)
            fail(404, 'RESOURCE_UNAVAILABLE');
        const kb = await this.kb(c, m, row.kb_id, 'manage');
        if (write && !['write', 'delete', 'manage_acl'].every(a => kb.capabilities.includes(a as never)))
            fail(404, 'RESOURCE_UNAVAILABLE');
        return row;
    }
    private async guard(c: PoolClient, m: IdentityContext, row: any, run: any) {
        await this.connectorScope(c, m, row.id, true);
        const current = (await c.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [row.tenant_id, row.id])).rows[0], r = (await c.query('SELECT * FROM connector_run WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [row.tenant_id, run.id])).rows[0];
        if (!current || ['paused', 'removed'].includes(current.status) || !r || r.status !== 'running' || r.worker_token !== run.worker_token)
            fail(409, 'SYNC_FENCED');
        return current;
    }
    private async connectorEvent(c: PoolClient, row: any, run: string | null, kind: string, member?: string, code?: string) { await c.query('INSERT INTO connector_event(tenant_id,connector_id,run_id,kind,member_id,error_code) VALUES($1,$2,$3,$4,$5,$6)', [row.tenant_id, row.id, run, kind, member ?? null, code ?? null]); }
    async createConnector(current: IdentityContext, kb: string, ref: string, key: string, request: string) {
        const kh = keyHash(key), ph = sourceHash(JSON.stringify(['create', kb, ref]));
        return this.run(current, async (c, m) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`connector-create:${m.tenant_id}:${m.membership_id}:${kh}`]);
            const permit = await this.kb(c, m, kb, 'manage', true);
            if (!['write', 'delete', 'manage_acl'].every(a => permit.capabilities.includes(a as never)))
                fail(404, 'RESOURCE_UNAVAILABLE');
            let binding: SourceBinding;
            try {
                binding = await sourceBinding(ref, m.tenant_id, kb);
            }
            catch (e) {
                fail(503, e instanceof SourceFailure ? e.code : 'SOURCE_CONFIG_INVALID');
            }
            const old = (await c.query('SELECT * FROM connector_request WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0];
            if (old) {
                if (old.payload_hash !== ph || old.kind !== 'create')
                    fail(409, 'IDEMPOTENCY_CONFLICT');
                return connectorView(await this.connectorScope(c, m, old.resource_id));
            }
            if ((await c.query("SELECT 1 FROM source_connector WHERE tenant_id=$1 AND kb_id=$2 AND config_ref=$3 AND status<>'removed'", [m.tenant_id, kb, ref])).rowCount)
                fail(409, 'CONNECTOR_ALREADY_EXISTS');
            const row = (await c.query("INSERT INTO source_connector(tenant_id,id,kb_id,owner_id,actor_id,config_ref,config_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,'blocked') RETURNING *", [m.tenant_id, randomUUID(), kb, m.membership_id, m.actor_id, ref, binding!.hash])).rows[0];
            await c.query('INSERT INTO connector_request VALUES($1,$2,$3,$4,$5,$6)', [m.tenant_id, m.membership_id, kh, ph, row.id, 'create']);
            await this.connectorEvent(c, row, null, 'created', m.membership_id);
            await this.audit(c, m, row.id, 'connector.created', request);
            return connectorView(row);
        });
    }
    listConnectors(current: IdentityContext, kb: string, input: ListInput) { return this.run(current, async (c, m) => { await this.kb(c, m, kb, 'manage'); const scope = this.scopeCursor(m, input, kb), after = this.cursor(input, scope); const rows = (await c.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND kb_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5', [m.tenant_id, kb, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows; const p = this.page(rows, input, scope); return { ...p, data: p.data.map(connectorView) }; }); }
    private scopeCursor(m: IdentityContext & {
        authz_version: number;
    }, input: ListInput, kb: string) { return super.scope(m, input, `connectors:${kb}`); }
    getConnector(current: IdentityContext, id: string) { return this.run(current, async (c, m) => { const row = await this.connectorScope(c, m, id), runs = (await c.query('SELECT * FROM connector_run WHERE tenant_id=$1 AND connector_id=$2 ORDER BY created_at DESC LIMIT 20', [m.tenant_id, id])).rows, counts = (await c.query('SELECT state,count(*)::int AS count FROM source_item WHERE tenant_id=$1 AND connector_id=$2 GROUP BY state', [m.tenant_id, id])).rows, events = (await c.query('SELECT kind,error_code,created_at FROM connector_event WHERE tenant_id=$1 AND connector_id=$2 ORDER BY seq DESC LIMIT 30', [m.tenant_id, id])).rows; return { ...connectorView(row), runs: runs.map(runView), items: counts, events }; }); }
    listConnectorDocuments(current: IdentityContext, id: string, input: ListInput) { return this.run(current, async (c, m) => { const source = await this.connectorScope(c, m, id, true), scope = this.scopeCursor(m, input, `items:${id}`), after = this.cursor(input, scope); const rows = (await c.query('SELECT d.id,d.created_at,d.row_version,d.status,k.policy_version AS kb_policy_version,s.state FROM source_item s JOIN document d ON d.tenant_id=s.tenant_id AND d.id=s.document_id JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id WHERE s.tenant_id=$1 AND s.connector_id=$2 AND ($3::timestamptz IS NULL OR (d.created_at,d.id)<($3::timestamptz,$4::uuid)) ORDER BY d.created_at DESC,d.id DESC LIMIT $5', [m.tenant_id, id, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows; const page = this.page(rows, input, scope); return { ...page, data: page.data.map(r => ({ id: r.id, status: r.status, state: r.state, etag: docEtag(r) })) }; }); }
    startSync(current: IdentityContext, id: string, mode: 'incremental' | 'full', key: string, request: string) {
        const kh = keyHash(key), ph = sourceHash(JSON.stringify([id, mode]));
        return this.run(current, async (c, m) => {
            await this.connectorScope(c, m, id, true);
            const row = (await c.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [m.tenant_id, id])).rows[0];
            if (['paused', 'removed'].includes(row.status))
                fail(409, 'CONNECTOR_NOT_ACTIVE');
            const old = (await c.query('SELECT * FROM connector_request WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0];
            if (old) {
                if (old.kind !== 'sync' || old.payload_hash !== ph)
                    fail(409, 'IDEMPOTENCY_CONFLICT');
                return runView((await c.query('SELECT * FROM connector_run WHERE tenant_id=$1 AND id=$2', [m.tenant_id, old.resource_id])).rows[0]);
            }
            if ((await c.query("SELECT 1 FROM connector_run WHERE tenant_id=$1 AND connector_id=$2 AND status IN ('queued','running','retry_wait')", [m.tenant_id, id])).rowCount)
                fail(409, 'SYNC_ALREADY_RUNNING');
            const r = (await c.query("INSERT INTO connector_run(tenant_id,id,connector_id,mode,status) VALUES($1,$2,$3,$4,'queued') RETURNING *", [m.tenant_id, randomUUID(), id, mode])).rows[0];
            await c.query('INSERT INTO connector_request VALUES($1,$2,$3,$4,$5,$6)', [m.tenant_id, m.membership_id, kh, ph, r.id, 'sync']);
            await this.connectorEvent(c, row, r.id, 'queued', m.membership_id);
            await this.audit(c, m, id, 'connector.sync_requested', request);
            return runView(r);
        });
    }
    connectorAction(current: IdentityContext, id: string, action: 'pause' | 'resume' | 'remove', etag: string | undefined, request: string) {
        return this.run(current, async (c, m) => {
            const r = await this.connectorScope(c, m, id, true), row = (await c.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [m.tenant_id, id])).rows[0];
            if (!etag)
                fail(428, 'IF_MATCH_REQUIRED');
            if (etag !== `"connector:${id}:${row.row_version}"`)
                fail(412, 'RESOURCE_VERSION_CHANGED');
            if (row.status === 'removed')
                fail(409, 'CONNECTOR_REMOVED');
            const status = action === 'pause' ? 'paused' : action === 'remove' ? 'removed' : 'blocked';
            const updated = (await c.query('UPDATE source_connector SET status=$3,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [m.tenant_id, id, status])).rows[0];
            await c.query("UPDATE connector_run SET status='cancelled',worker_token=NULL,finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND status IN ('queued','running','retry_wait')", [m.tenant_id, id]);
            await this.connectorEvent(c, r, null, action, m.membership_id);
            await this.audit(c, m, id, `connector.${action}`, request);
            return connectorView(updated);
        });
    }
    private identityFor(row: any): IdentityContext { return { tenant_id: row.tenant_id, membership_id: row.owner_id, actor_id: row.actor_id, provider: 'development', role: 'operator', capabilities: [] }; }
    private async mapReaders(c: PoolClient, row: any, binding: SourceBinding, item: any, readers: string[], seq: number) {
        if (item.state === 'deleted')
            return;
        const mapped: Array<{
            type: 'member' | 'group';
            id: string;
        }> = [];
        let valid = true;
        for (const name of [...new Set(readers)]) {
            const p = binding.principals[name];
            if (!p) {
                valid = false;
                continue;
            }
            const exists = await c.query(p.type === 'member' ? "SELECT 1 FROM membership WHERE tenant_id=$1 AND id=$2 AND status='active'" : "SELECT 1 FROM workspace_group WHERE tenant_id=$1 AND id=$2", [row.tenant_id, p.id]);
            if (!exists.rowCount)
                valid = false;
            else if (!mapped.some(v => v.type === p.type && v.id === p.id))
                mapped.push(p);
        }
        await c.query('DELETE FROM source_reader WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, item.external_id]);
        if (valid)
            for (const p of mapped)
                await c.query('INSERT INTO source_reader(tenant_id,connector_id,external_id,member_id,group_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [row.tenant_id, row.id, item.external_id, p.type === 'member' ? p.id : null, p.type === 'group' ? p.id : null]);
        const state = !valid ? 'quarantined' : !readers.length ? 'revoked' : item.version_id ? 'active' : 'importing';
        await c.query('UPDATE source_item SET source_readers=$4,state=$5,security_seq=GREATEST(security_seq,$6),updated_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, item.external_id, readers, state, seq]);
        if (item.document_id) {
            await c.query('DELETE FROM acl_entry WHERE tenant_id=$1 AND document_id=$2', [row.tenant_id, item.document_id]);
            await c.query('INSERT INTO acl_entry(tenant_id,id,document_id,member_id,actions) VALUES($1,$2,$3,$4,$5)', [row.tenant_id, randomUUID(), item.document_id, row.owner_id, ['read', 'write', 'delete', 'manage', 'manage_acl', ...(valid && mapped.some(p => p.type === 'member' && p.id === row.owner_id) ? ['download'] : [])]]);
            if (valid)
                for (const p of mapped) {
                    if (p.type === 'member' && p.id === row.owner_id)
                        continue;
                    await c.query('INSERT INTO acl_entry(tenant_id,id,document_id,member_id,group_id,actions) VALUES($1,$2,$3,$4,$5,$6)', [row.tenant_id, randomUUID(), item.document_id, p.type === 'member' ? p.id : null, p.type === 'group' ? p.id : null, ['read', 'download']]);
                }
            await c.query("UPDATE document SET acl_mode='restricted',policy_version=policy_version+1,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2", [row.tenant_id, item.document_id]);
        }
    }
    private async prepare(row: any, run: any, binding: SourceBinding, snapshot: SourceSnapshot) {
        const identity = this.identityFor(row);
        return this.run(identity, async (c, m) => {
            const current = await this.guard(c, m, row, run);
            if (snapshot.end < Number(current.cursor) || snapshot.end < Number(current.observed_end))
                fail(409, 'SOURCE_CURSOR_REGRESSED');
            await c.query("UPDATE source_connector SET status='blocked',observed_end=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, snapshot.end]);
            for (const p of snapshot.pages) {
                const old = (await c.query('SELECT * FROM source_page WHERE tenant_id=$1 AND connector_id=$2 AND start_seq=$3', [row.tenant_id, row.id, p.start_seq])).rows[0];
                if (old && (old.digest !== p.sha256 || Number(old.end_seq) !== p.end_seq))
                    fail(409, 'SOURCE_HISTORY_CHANGED');
                await c.query('INSERT INTO source_page VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [row.tenant_id, row.id, p.start_seq, p.end_seq, p.sha256]);
            }
            if (current.mapping_hash !== binding.mapping_hash) {
                const items = (await c.query("SELECT * FROM source_item WHERE tenant_id=$1 AND connector_id=$2 AND state<>'deleted' ORDER BY external_id", [row.tenant_id, row.id])).rows;
                for (const item of items)
                    await this.mapReaders(c, row, binding, item, item.source_readers, Number(item.security_seq));
                await c.query('UPDATE source_connector SET mapping_hash=$3 WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id, binding.mapping_hash]);
                await this.connectorEvent(c, row, run.id, 'mapping_verified');
            }
            const pending = snapshot.events.filter(e => e.seq > Number(current.cursor)).slice(0, 100);
            for (const e of pending) {
                await c.query("INSERT INTO source_item(tenant_id,connector_id,external_id,state) VALUES($1,$2,$3,'importing') ON CONFLICT DO NOTHING", [row.tenant_id, row.id, e.external_id]);
                const old = (await c.query('SELECT digest FROM source_event WHERE tenant_id=$1 AND connector_id=$2 AND seq=$3', [row.tenant_id, row.id, e.seq])).rows[0];
                if (old && old.digest !== sourceHash(JSON.stringify(e)))
                    fail(409, 'SOURCE_HISTORY_CHANGED');
                await c.query('INSERT INTO source_event(tenant_id,connector_id,seq,external_id,digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [row.tenant_id, row.id, e.seq, e.external_id, sourceHash(JSON.stringify(e))]);
            }
            // Access is globally blocked before content work; each existing item's newest ACL in this window is applied first.
            for (const e of pending) {
                if (e.kind === 'delete')
                    continue;
                const item = (await c.query('SELECT * FROM source_item WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3 FOR UPDATE', [row.tenant_id, row.id, e.external_id])).rows[0];
                if (Number(item.security_seq) < e.seq)
                    await this.mapReaders(c, row, binding, item, e.readers!, e.seq);
            }
            return pending;
        });
    }
    private async ack(c: PoolClient, row: any, run: any, e: SourceEvent, status = 'applied') { await c.query('UPDATE source_event SET status=$4,applied_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND seq=$3', [row.tenant_id, row.id, e.seq, status]); await c.query('UPDATE source_connector SET cursor=GREATEST(cursor,$3),updated_at=now() WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id, e.seq]); await c.query('UPDATE connector_run SET applied=applied+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [row.tenant_id, run.id]); }
    private async apply(row: any, run: any, binding: SourceBinding, source: DirectorySource, e: SourceEvent) {
        const identity = this.identityFor(row), request = run.id;
        let item = await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); return (await c.query('SELECT * FROM source_item WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3 FOR UPDATE', [row.tenant_id, row.id, e.external_id])).rows[0]; });
        if (item.document_id && (await this.pool!.query('SELECT 1 FROM document_tombstone WHERE tenant_id=$1 AND document_id=$2', [row.tenant_id, item.document_id])).rowCount)
            item.state = 'deleted';
        if (item.state === 'deleted') {
            await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query("UPDATE source_item SET state='deleted',fresh_until=now() WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3", [row.tenant_id, row.id, e.external_id]); await this.ack(c, row, run, e, 'ignored'); });
            return;
        }
        if (e.kind === 'delete') {
            await this.run(identity, async (c, m) => {
                await this.guard(c, m, row, run);
                if (item.document_id) {
                    const d = (await c.query('SELECT status FROM document WHERE tenant_id=$1 AND id=$2', [row.tenant_id, item.document_id])).rows[0];
                    if (d?.status !== 'deleted') {
                        const view = await this.doc(c, m, item.document_id, 'delete', true);
                        await this.deleteDocumentInTransaction(c, m, item.document_id, docEtag(view), `source-delete-${sourceHash(row.id + e.seq).slice(0, 40)}`, request);
                    }
                }
                await c.query("UPDATE source_item SET state='deleted',last_seq=$4,source_readers='{}',fresh_until=now(),updated_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3", [row.tenant_id, row.id, e.external_id, e.seq]);
                await c.query('DELETE FROM source_reader WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id]);
                await this.ack(c, row, run, e);
                await this.connectorEvent(c, row, run.id, 'source_deleted');
            });
            return;
        }
        if (e.kind === 'acl') {
            await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query('UPDATE source_item SET last_seq=GREATEST(last_seq,$4),updated_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id, e.seq]); await this.ack(c, row, run, e); });
            return;
        }
        if (item.content_sha256 === e.sha256 && item.version_id) {
            await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query('UPDATE source_item SET last_seq=$4,revision_hash=$5,updated_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id, e.seq, sourceHash(e.revision)]); await this.ack(c, row, run, e); });
            return;
        }
        // New content invalidates the previous publication before object I/O; a failed import stays unreadable.
        await this.run(identity, async (c, m) => {
            await this.guard(c, m, row, run);
            if (item.document_id)
                await c.query("UPDATE document SET status='draft',published_version_id=NULL,published_generation_id=NULL,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2 AND status<>'deleted' AND (status<>'draft' OR published_version_id IS NOT NULL OR published_generation_id IS NOT NULL)", [row.tenant_id, item.document_id]);
            await c.query("UPDATE source_item SET state=CASE WHEN state IN ('revoked','quarantined') THEN state ELSE 'importing' END WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3", [row.tenant_id, row.id, e.external_id]);
        });
        const bytes = await source.content(e);
        if (!item.pending_ticket_id || Number(item.pending_seq) !== e.seq) {
            const token = `source-${sourceHash([row.id, e.seq, item.ticket_generation].join(':')).slice(0, 48)}`;
            let ticket;
            try {
                ticket = await this.createUpload(identity, { kb_id: row.kb_id, ...(item.document_id ? { document_id: item.document_id } : {}), filename: e.filename!, mime: e.mime!, size: e.size!, sha256: e.sha256! }, token, request);
            }
            catch (error) {
                if (error instanceof ResourceError && error.status === 410)
                    await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query('UPDATE source_item SET ticket_generation=ticket_generation+1,pending_ticket_id=NULL WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id]); });
                throw error;
            }
            await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query('UPDATE source_item SET pending_ticket_id=$4,pending_seq=$5 WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id, ticket.ticket_id, e.seq]); });
            item = { ...item, pending_ticket_id: ticket.ticket_id, pending_seq: e.seq };
        }
        let ticket;
        try {
            ticket = await this.getUpload(identity, item.pending_ticket_id);
        }
        catch (error) {
            if (error instanceof ResourceError && error.status === 410)
                await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query('UPDATE source_item SET pending_ticket_id=NULL,ticket_generation=ticket_generation+1 WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id]); });
            throw error;
        }
        if (ticket.status === 'open')
            await this.receiveUpload(identity, ticket.ticket_id, e.mime!, e.size, async () => bytes, request);
        try {
            await this.run(identity, async (c, m) => {
                await this.quotaLock(c, m.tenant_id);
                await this.guard(c, m, row, run);
                const latest = (await c.query('SELECT * FROM source_item WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3 FOR UPDATE', [row.tenant_id, row.id, e.external_id])).rows[0];
                const result = await this.finalizeUploadInTransaction(c, m, ticket.ticket_id, e.sha256!, request);
                const deleted = (await c.query('SELECT 1 FROM document_tombstone WHERE tenant_id=$1 AND document_id=$2', [row.tenant_id, result.document_id])).rowCount;
                if (deleted)
                    fail(409, 'SOURCE_DOCUMENT_DELETED');
                await c.query('UPDATE source_item SET document_id=$4,version_id=$5,content_sha256=$6,revision_hash=$7,last_seq=$8,pending_ticket_id=NULL,updated_at=now() WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id, result.document_id, result.version_id, e.sha256, sourceHash(e.revision), e.seq]);
                await c.query('UPDATE document SET latest_version_id=$3 WHERE tenant_id=$1 AND id=$2', [row.tenant_id, result.document_id, result.version_id]);
                await this.mapReaders(c, row, binding, { ...latest, document_id: result.document_id, version_id: result.version_id }, latest.source_readers, Number(latest.security_seq));
                await this.ack(c, row, run, e);
                await this.audit(c, m, result.document_id, 'connector.version_imported', request);
            });
        }
        catch (error) {
            if (error instanceof ResourceError && error.code === 'DOCUMENT_CHANGED')
                await this.run(identity, async (c, m) => { await this.guard(c, m, row, run); await c.query('UPDATE source_item SET pending_ticket_id=NULL,ticket_generation=ticket_generation+1 WHERE tenant_id=$1 AND connector_id=$2 AND external_id=$3', [row.tenant_id, row.id, e.external_id]); });
            throw error;
        }
    }
    async connectorTick() {
        if (!connectorSettings().enabled)
            return false;
        // Poll only verified active connectors; blocked/paused sources require an explicit operator retry.
        await transaction(this.pool, async (c) => {
            const due = (await c.query("SELECT * FROM source_connector s WHERE status='active' AND next_poll_at<=now() AND NOT EXISTS(SELECT 1 FROM connector_run r WHERE r.tenant_id=s.tenant_id AND r.connector_id=s.id AND r.status IN ('queued','running','retry_wait')) LIMIT 20 FOR UPDATE SKIP LOCKED")).rows;
            for (const row of due) {
                await c.query("INSERT INTO connector_run(tenant_id,id,connector_id,mode,status) VALUES($1,$2,$3,'incremental','queued')", [row.tenant_id, randomUUID(), row.id]);
                await c.query("UPDATE source_connector SET next_poll_at=now()+($3::int*interval '1 second') WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, connectorSettings().intervalSeconds]);
            }
        });
        const candidates = (await this.pool!.query("SELECT r.* FROM connector_run r JOIN source_connector s ON s.tenant_id=r.tenant_id AND s.id=r.connector_id WHERE r.status IN ('queued','running','retry_wait') AND r.next_run_at<=now() AND s.status NOT IN ('paused','removed') ORDER BY r.created_at LIMIT 20")).rows;
        for (const candidate of candidates) {
            const lock = await this.pool!.connect(), name = `connector:${candidate.tenant_id}:${candidate.connector_id}`;
            let held = false, broken = false;
            const lost = () => { broken = true; };
            lock.on('error', lost);
            try {
                held = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', [name])).rows[0].held;
                if (!held)
                    continue;
                const row = (await this.pool!.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND id=$2', [candidate.tenant_id, candidate.connector_id])).rows[0];
                const run = await this.run(this.identityFor(row), async (c, m) => {
                    await this.connectorScope(c, m, row.id, true);
                    const latest = (await c.query('SELECT * FROM source_connector WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [row.tenant_id, row.id])).rows[0];
                    if (['paused', 'removed'].includes(latest.status))
                        return null;
                    const r = (await c.query('SELECT * FROM connector_run WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [row.tenant_id, candidate.id])).rows[0];
                    if (!['queued', 'running', 'retry_wait'].includes(r.status) || r.next_run_at > new Date())
                        return null;
                    await c.query("UPDATE source_connector SET status='blocked',updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
                    return (await c.query("UPDATE connector_run SET status='running',attempts=attempts+1,worker_token=$3,started_at=COALESCE(started_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [row.tenant_id, r.id, randomUUID()])).rows[0];
                });
                if (!run)
                    continue;
                try {
                    const binding = await sourceBinding(row.config_ref, row.tenant_id, row.kb_id);
                    if (binding.hash !== row.config_hash)
                        throw new SourceFailure('SOURCE_CONFIG_CHANGED');
                    const source = new DirectorySource(binding), snapshot = await source.snapshot(), pending = await this.prepare(row, run, binding, snapshot);
                    for (const e of pending.slice(0, 20)) {
                        await this.apply(row, run, binding, source, e);
                    }
                    await this.run(this.identityFor(row), async (c, m) => {
                        const current = await this.guard(c, m, row, run);
                        if (Number(current.cursor) >= snapshot.end) {
                            const expiry = new Date(Math.min(snapshot.validUntil.getTime(), Date.now() + binding.freshness_seconds * 1000));
                            if (expiry.getTime() <= Date.now())
                                fail(409, 'SOURCE_ATTESTATION_EXPIRED');
                            await c.query("UPDATE source_item SET fresh_until=$3 WHERE tenant_id=$1 AND connector_id=$2 AND state<>'deleted'", [row.tenant_id, row.id, expiry]);
                            await c.query("UPDATE source_connector SET status='active',next_poll_at=now()+($3::int*interval '1 second'),updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, connectorSettings().intervalSeconds]);
                            await c.query("UPDATE connector_run SET status='succeeded',worker_token=NULL,pages=$3,finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, run.id, snapshot.pages.length]);
                            await this.connectorEvent(c, row, run.id, 'completed');
                        }
                        else {
                            await c.query("UPDATE connector_run SET status='queued',worker_token=NULL,attempts=0,pages=$3,next_run_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, run.id, snapshot.pages.length]);
                            await this.connectorEvent(c, row, run.id, 'batch_committed');
                        }
                    });
                }
                catch (error) {
                    await transaction(this.pool, async (c) => {
                        await c.query('SELECT id FROM source_connector WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [row.tenant_id, row.id]);
                        const code = error instanceof SourceFailure || error instanceof ResourceError ? error.code : 'SOURCE_SYNC_UNAVAILABLE', auth = ['SOURCE_AUTH_FAILED', 'SOURCE_CONFIG_CHANGED', 'SOURCE_NOT_CONFIGURED', 'SOURCE_CONFIG_INVALID', 'SOURCE_ATTESTATION_EXPIRED', 'SOURCE_PROTOCOL_INVALID', 'SOURCE_HISTORY_CHANGED', 'SOURCE_CURSOR_REGRESSED', 'RESOURCE_UNAVAILABLE', 'MEMBERSHIP_INACTIVE'].includes(code), retry = !auth && run.attempts < 3, status = auth ? 'blocked' : retry ? 'retry_wait' : 'failed', delay = error instanceof SourceFailure && error.retryMs ? error.retryMs : Math.min(30000, 1000 * 2 ** run.attempts);
                        const updated = await c.query("UPDATE connector_run SET status=$4,error_code=$5,worker_token=NULL,next_run_at=now()+($6::int*interval '1 millisecond'),finished_at=CASE WHEN $4 IN ('blocked','failed') THEN now() ELSE NULL END,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND worker_token=$3 AND status='running'", [row.tenant_id, run.id, run.worker_token, status, code, Math.ceil(delay)]);
                        if (updated.rowCount) {
                            await c.query("UPDATE source_connector SET status='blocked',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('paused','removed')", [row.tenant_id, row.id]);
                            await this.connectorEvent(c, row, run.id, status, undefined, code);
                        }
                    });
                }
                return true;
            }
            catch (error) {
                await transaction(this.pool, async (c) => {
                    await c.query('SELECT id FROM source_connector WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [candidate.tenant_id, candidate.connector_id]);
                    const updated = await c.query("UPDATE connector_run SET status='blocked',worker_token=NULL,error_code='SOURCE_OPERATOR_UNAVAILABLE',finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running','retry_wait') RETURNING id", [candidate.tenant_id, candidate.id]);
                    if (updated.rowCount) {
                        await c.query("UPDATE source_connector SET status='blocked' WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('paused','removed')", [candidate.tenant_id, candidate.connector_id]);
                        await this.connectorEvent(c, { tenant_id: candidate.tenant_id, id: candidate.connector_id }, candidate.id, 'blocked', undefined, 'SOURCE_OPERATOR_UNAVAILABLE');
                    }
                });
                return true;
            }
            finally {
                if (held && !broken)
                    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name]).catch(() => { });
                lock.removeListener('error', lost);
                lock.release(broken);
            }
        }
        return false;
    }
}
