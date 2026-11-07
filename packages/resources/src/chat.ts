import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ChatRun, ChatEvent, Conversation, IdentityContext, SearchInput, SearchEvidence, AnswerResponse, ResourcePage } from '@zhiheng/contracts';
import {lifecyclePolicy} from './lifecycle-policy';
import { AnswerStore } from './answers';
import { transaction } from './database';
import { fail, ResourceError } from './policy';
import type { ListInput } from './store';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function keyHash(key: string) { if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    fail(400, 'IDEMPOTENCY_KEY_REQUIRED'); return hash(key); }
const conversationView = (r: any): Conversation => ({ id: r.id, title: r.title, row_version: r.row_version, created_at: r.created_at.toISOString() });
export class ChatStore extends AnswerStore {
    private executions = new Map<string, {
        abort: AbortController;
        done: Promise<void>;
    }>();
    private async owner(client: PoolClient, member: IdentityContext, id: string, lock = false) { const row = (await client.query(`SELECT * FROM conversation WHERE tenant_id=$1 AND id=$2 AND member_id=$3 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [member.tenant_id, id, member.membership_id])).rows[0]; if (!row)
        fail(404, 'RESOURCE_UNAVAILABLE'); return row; }
    private async event(client: PoolClient, tenant: string, run: string, type: ChatEvent['type'], payload: object = {}) { const row = (await client.query('UPDATE chat_run SET last_event_id=last_event_id+1 WHERE tenant_id=$1 AND id=$2 RETURNING last_event_id', [tenant, run])).rows[0]; await client.query('INSERT INTO chat_event(tenant_id,run_id,seq,type,payload) VALUES($1,$2,$3,$4,$5)', [tenant, run, row.last_event_id, type, JSON.stringify(payload)]); }
    protected async terminal(client: PoolClient, row: any, status: 'failed' | 'cancelled', code: string) { if (row.status !== 'running')
        return; await this.event(client, row.tenant_id, row.id, status === 'cancelled' ? 'run.cancelled' : 'run.failed', { error_code: code }); await client.query("UPDATE chat_run SET status=$3,stage='finished',error_code=$4,finished_at=now(),cancel_requested_at=CASE WHEN $3='cancelled' THEN now() ELSE cancel_requested_at END WHERE tenant_id=$1 AND id=$2 AND status='running'", [row.tenant_id, row.id, status, code]); }
    private async expire(client: PoolClient, tenant: string, member?: string) { const rows = await client.query("SELECT * FROM chat_run WHERE tenant_id=$1 AND ($2::uuid IS NULL OR member_id=$2) AND status='running' AND deadline_at<now() ORDER BY id FOR UPDATE", [tenant, member ?? null]); for (const row of rows.rows)
        await this.terminal(client, row, 'failed', 'EXECUTION_INTERRUPTED'); }
    async createConversation(current: IdentityContext, title: string, key: string) { const kh = keyHash(key), ph = hash(title); return this.run(current, async (c, m) => { await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`chat:${m.tenant_id}:${m.membership_id}`]); const old = (await c.query('SELECT * FROM conversation WHERE tenant_id=$1 AND member_id=$2 AND idempotency_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0]; if (old) {
        if (old.payload_hash !== ph)
            fail(409, 'IDEMPOTENCY_CONFLICT');
        if (old.deleted_at)
            fail(404, 'RESOURCE_UNAVAILABLE');
        return conversationView(old);
    } const row = (await c.query('INSERT INTO conversation(tenant_id,id,member_id,title,idempotency_hash,payload_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [m.tenant_id, randomUUID(), m.membership_id, title, kh, ph])).rows[0]; return conversationView(row); }); }
    async conversations(current: IdentityContext, input: ListInput): Promise<ResourcePage<Conversation>> { return this.run(current, async (c, m) => { const scope = this.scope(m, input, 'conversations'), after = this.cursor(input, scope), rows = await c.query("SELECT * FROM conversation WHERE tenant_id=$1 AND member_id=$2 AND deleted_at IS NULL AND title ILIKE $3 AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6", [m.tenant_id, m.membership_id, `%${input.q}%`, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1]); const page = this.page(rows.rows, input, scope); return { ...page, data: page.data.map(conversationView) }; }); }
    async renameConversation(current: IdentityContext, id: string, title: string, version: number) { return this.run(current, async (c, m) => { const row = await this.owner(c, m, id, true); if (row.row_version !== version)
        fail(412, 'RESOURCE_VERSION_CHANGED'); return conversationView((await c.query('UPDATE conversation SET title=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *', [m.tenant_id, id, title])).rows[0]); }); }
    async deleteConversation(current: IdentityContext, id: string) { return this.run(current, async (c, m) => { await this.owner(c, m, id, true); const rows = await c.query("SELECT * FROM chat_run WHERE tenant_id=$1 AND conversation_id=$2 AND status='running' ORDER BY id FOR UPDATE", [m.tenant_id, id]); for (const row of rows.rows)
        await this.terminal(c, row, 'cancelled', 'CONVERSATION_DELETED'); await c.query('UPDATE conversation SET deleted_at=now(),row_version=row_version+1 WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id]); return { id, status: 'deleted' as const }; }); }
    async createChatRun(current: IdentityContext, conversation: string, input: SearchInput, key: string, parent?: string): Promise<ChatRun> {
        const kh = keyHash(key), ph = hash(JSON.stringify({ conversation, input, parent: parent ?? null }));
        const created = await this.run(current, async (c, m) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`chat:${m.tenant_id}:${m.membership_id}`]);
            await this.owner(c, m, conversation, true);
            await this.expire(c, m.tenant_id, m.membership_id);
            const old = (await c.query('SELECT * FROM chat_run WHERE tenant_id=$1 AND member_id=$2 AND idempotency_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0];
            if (old) {
                if (old.payload_hash !== ph)
                    fail(409, 'IDEMPOTENCY_CONFLICT');
                return { id: old.id, fresh: false };
            }
            if (parent) {
                const prior = (await c.query('SELECT conversation_id,status FROM chat_run WHERE tenant_id=$1 AND id=$2 AND member_id=$3', [m.tenant_id, parent, m.membership_id])).rows[0];
                if (!prior || prior.conversation_id !== conversation)
                    fail(404, 'RESOURCE_UNAVAILABLE');
                if (prior.status === 'running')
                    fail(409, 'CONVERSATION_BUSY');
            }
            if ((await c.query("SELECT 1 FROM chat_run WHERE tenant_id=$1 AND conversation_id=$2 AND status='running'", [m.tenant_id, conversation])).rowCount)
                fail(409, 'CONVERSATION_BUSY');
            if (Number((await c.query("SELECT count(*) FROM chat_run WHERE tenant_id=$1 AND member_id=$2 AND status='running'", [m.tenant_id, m.membership_id])).rows[0].count) >= 1)
                fail(429, 'CHAT_RUN_LIMIT');
            if (input.kb_ids)
                for (const kb of [...input.kb_ids].sort())
                    await this.kb(c, m, kb, 'read');
            const id = randomUUID();
            await c.query("INSERT INTO chat_run(tenant_id,id,conversation_id,member_id,question_message_id,message_id,parent_run_id,idempotency_hash,payload_hash,input,status,stage,content_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running','queued',now()+($11::int*interval '1 day'))", [m.tenant_id, id, conversation, m.membership_id, randomUUID(), randomUUID(), parent ?? null, kh, ph, JSON.stringify(input),lifecyclePolicy().historyDays]);
            await this.event(c, m.tenant_id, id, 'run.started', { stage: 'queued' });
            return { id, fresh: true };
        });
        if (created.fresh) {
            const abort = new AbortController(), done = this.executeChat(current, created.id, input, abort).catch(() => { });
            this.executions.set(created.id, { abort, done });
            void done.finally(() => this.executions.delete(created.id));
        }
        return this.chatRun(current, created.id);
    }
    private async changeStage(current:IdentityContext,id:string,stage:string,dependencies?:SearchEvidence[]){
      const update=async(c:PoolClient)=>{const row=(await c.query('SELECT * FROM chat_run WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[current.tenant_id,id])).rows[0];if(!row||row.status!=='running')fail(409,'RUN_TERMINAL');await c.query('UPDATE chat_run SET stage=$3,dependencies=COALESCE($4::jsonb,dependencies) WHERE tenant_id=$1 AND id=$2',[current.tenant_id,id,stage,dependencies?JSON.stringify(dependencies):null]);await this.event(c,current.tenant_id,id,'run.progress',{stage})};
      return dependencies?this.withEvidence(current,dependencies,(_,c)=>update(c)):this.run(current,c=>update(c));
    }
    private async systemEnd(tenant: string, id: string, code: string) { return transaction(this.pool, async (c) => { const row = (await c.query('SELECT * FROM chat_run WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenant, id])).rows[0]; if (row)
        await this.terminal(c, row, 'failed', code); }); }
    private async executeChat(current: IdentityContext, id: string, input: SearchInput, abort: AbortController) {
        let sources: SearchEvidence[] = [], checking = false;
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(95000)]);
        const monitor = setInterval(() => { if (checking)
            return; checking = true; void this.chatRun(current, id).then(async (run) => { if (run.status !== 'running') {
            if (run.status === 'restricted' || run.status === 'expired')
                await this.systemEnd(current.tenant_id, id, 'ACCESS_CHANGED');
            abort.abort();
        } }).catch(async () => { await this.systemEnd(current.tenant_id, id, 'ACCESS_CHANGED').catch(() => { }); abort.abort(); }).finally(() => { checking = false; }); }, 300);
        monitor.unref();
        try {
            const answer = await this.answer(current, input, signal, { evidence: async (evidence) => { sources = evidence; await this.changeStage(current, id, 'retrieving', evidence); }, progress: stage => this.changeStage(current, id, stage) });
            if (signal.aborted)
                throw new Error();
            await this.withEvidence(current, sources, async (fresh, c) => {
                await this.owner(c, current, (await c.query('SELECT conversation_id FROM chat_run WHERE tenant_id=$1 AND id=$2', [current.tenant_id, id])).rows[0].conversation_id);
                const row = (await c.query('SELECT * FROM chat_run WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [current.tenant_id, id])).rows[0];
                if (row.status !== 'running')
                    return;
                if (row.deadline_at.getTime() < Date.now()) {
                    await this.terminal(c, row, 'failed', 'EXECUTION_INTERRUPTED');
                    return;
                }
                const result = { ...answer, sources: answer.sources.map(s => fresh.find(f => f.evidence_id === s.evidence_id)!) };
                for (const source of result.sources)
                    await this.event(c, current.tenant_id, id, 'citation.upsert', { evidence_id: source.evidence_id });
                for (const [i, claim] of result.claims.entries()) {
                    let start = 0;
                    const points = Array.from(claim.quote);
                    for (let part = 0; part < points.length; part += 64) {
                        const text = points.slice(part, part + 64).join('');
                        await this.event(c, current.tenant_id, id, 'answer.delta', { claim_index: i, start, end: start + text.length });
                        start += text.length;
                    }
                }
                const failed = answer.status === 'failed';
                await this.event(c, current.tenant_id, id, failed ? 'run.failed' : 'run.completed', { error_code: failed ? answer.reason : null });
                await c.query("UPDATE chat_run SET status=$3,stage='finished',result=$4,error_code=$5,finished_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", [current.tenant_id, id, failed ? 'failed' : 'completed', JSON.stringify(result), failed ? answer.reason : null]);
            });
        }
        catch (error) {
            await this.systemEnd(current.tenant_id, id, error instanceof ResourceError && error.status === 404 ? 'ACCESS_CHANGED' : signal.aborted ? 'EXECUTION_INTERRUPTED' : 'ANSWER_EXECUTION_FAILED').catch(() => { });
        }
        finally {
            clearInterval(monitor);
        }
    }
    async chatRun(current: IdentityContext, id: string): Promise<ChatRun> {
        await this.run(current, (c, m) => this.expire(c, m.tenant_id, m.membership_id));
        const row = await this.run(current, async (c, m) => { const r = (await c.query('SELECT r.*,f.value AS feedback FROM chat_run r LEFT JOIN chat_feedback f ON f.tenant_id=r.tenant_id AND f.run_id=r.id AND f.member_id=r.member_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.member_id=$3', [m.tenant_id, id, m.membership_id])).rows[0]; if (!r)
            fail(404, 'RESOURCE_UNAVAILABLE'); await this.owner(c, m, r.conversation_id); return r; });
        const view = (answer: AnswerResponse | null, status: ChatRun['status'] = row.status): ChatRun => ({ id: row.id, conversation_id: row.conversation_id, question_message_id: row.question_message_id, message_id: row.message_id, parent_run_id: row.parent_run_id, question: status==='expired'?'[历史内容已清理]':row.input.query, status, stage: row.stage, last_event_id: row.last_event_id, answer, error_code: status === 'restricted' ? 'ACCESS_CHANGED' : row.error_code, feedback: status==='expired'?null:row.feedback ?? null, created_at: row.created_at.toISOString(), events_url: `/api/v1/chat-runs/${id}/events`, status_url: `/api/v1/chat-runs/${id}`, cancel_url: `/api/v1/chat-runs/${id}/cancel` });
        if(row.content_purged_at||row.content_expires_at.getTime()<=Date.now())return view(null,'expired');
        let sourceChecked = false;
        try {
            return await this.withEvidence(current, row.dependencies, async (fresh, c) => { sourceChecked = true; await this.owner(c, current, row.conversation_id); return view(row.result ? { ...row.result, sources: row.result.sources.map((s: SearchEvidence) => fresh.find(f => f.evidence_id === s.evidence_id)!) } : null); }, true);
        }
        catch (error) {
            if (!sourceChecked && error instanceof ResourceError && error.status === 404)
                return view(null, 'restricted');
            throw error;
        }
    }
    async messages(current: IdentityContext, conversation: string, input: ListInput): Promise<ResourcePage<ChatRun>> {
        const found = await this.run(current, async (c, m) => { await this.owner(c, m, conversation); const scope = this.scope(m, input, `messages:${conversation}`), after = this.cursor(input, scope), rows = (await c.query('SELECT id,created_at FROM chat_run WHERE tenant_id=$1 AND conversation_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5', [m.tenant_id, conversation, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows; return { rows, scope }; });
        const page = this.page(found.rows, input, found.scope);
        return { ...page, data: await Promise.all(page.data.map(row => this.chatRun(current, row.id))) };
    }
    async cancelChatRun(current: IdentityContext, id: string) { await this.run(current, async (c, m) => { const row = (await c.query('SELECT * FROM chat_run WHERE tenant_id=$1 AND id=$2 AND member_id=$3 FOR UPDATE', [m.tenant_id, id, m.membership_id])).rows[0]; if (!row)
        fail(404, 'RESOURCE_UNAVAILABLE'); await this.terminal(c, row, 'cancelled', 'USER_CANCELLED'); }); this.executions.get(id)?.abort.abort(); return this.chatRun(current, id); }
    async regenerateChatRun(current: IdentityContext, id: string, key: string) { const row = await this.run(current, async (c, m) => { const r = (await c.query('SELECT * FROM chat_run WHERE tenant_id=$1 AND id=$2 AND member_id=$3', [m.tenant_id, id, m.membership_id])).rows[0]; if (!r)
        fail(404, 'RESOURCE_UNAVAILABLE'); if(r.content_purged_at||r.content_expires_at.getTime()<=Date.now())fail(410,'HISTORY_EXPIRED');return r; }); return this.createChatRun(current, row.conversation_id, row.input, key, id); }
    async feedback(current: IdentityContext, id: string, value: 'helpful' | 'unhelpful') { const run = await this.chatRun(current, id); if (run.status !== 'completed' || !run.answer)
        fail(409, 'FEEDBACK_UNAVAILABLE'); await this.run(current, async (c, m) => { await this.owner(c, m, run.conversation_id); await c.query('INSERT INTO chat_feedback(tenant_id,run_id,member_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,run_id,member_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()', [m.tenant_id, id, m.membership_id, value]); }); return { value }; }
    async chatEvents(current: IdentityContext, id: string, after: number) {
        const run = await this.chatRun(current, id);
        if (after > run.last_event_id)
            fail(400, 'INVALID_EVENT_CURSOR');
        if (run.status === 'restricted' || run.status === 'expired')
            return { run, events: [], reset: run.status==='expired' };
        if (Date.now() - Date.parse(run.created_at) > 86400000)
            return { run, events: [], reset: true };
        const dependencies = await this.run(current, async (c, m) => (await c.query('SELECT dependencies FROM chat_run WHERE tenant_id=$1 AND id=$2 AND member_id=$3', [m.tenant_id, id, m.membership_id])).rows[0]?.dependencies ?? []);
        let sourceChecked = false;
        try {
            return await this.withEvidence(current, dependencies, async (fresh, c) => {
                sourceChecked = true;
                await this.owner(c, current, run.conversation_id);
                const rows = (await c.query('SELECT * FROM chat_event WHERE tenant_id=$1 AND run_id=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT 16', [current.tenant_id, id, after, run.last_event_id])).rows;
                const events: ChatEvent[] = rows.map(row => { const p = row.payload, event: ChatEvent = { run_id: id, seq: row.seq, type: row.type, message_id: run.message_id }; if (row.type === 'citation.upsert')
                    event.source = fresh.find(s => s.evidence_id === p.evidence_id);
                else if (row.type === 'answer.delta') {
                    const claim = run.answer?.claims[p.claim_index];
                    if (claim) {
                        event.claim_index = p.claim_index;
                        event.evidence_id = claim.evidence_id;
                        event.delta = claim.quote.slice(p.start, p.end);
                    }
                }
                else if (row.type === 'run.progress' || row.type === 'run.started')
                    event.stage = p.stage;
                else
                    event.error_code = p.error_code; return event; });
                return { run, events, reset: false };
            }, true);
        }
        catch (error) {
            if (!sourceChecked && error instanceof ResourceError && error.status === 404)
                return { run: { ...run, status: 'restricted' as const, answer: null, error_code: 'ACCESS_CHANGED' }, events: [], reset: false };
            throw error;
        }
    }
    async openChatStream(current: IdentityContext, id: string) { await this.chatRun(current, id); return this.run(current, async (c, m) => { await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stream:${m.tenant_id}:${m.membership_id}`]); await c.query('DELETE FROM chat_stream_lease WHERE tenant_id=$1 AND member_id=$2 AND expires_at<now()', [m.tenant_id, m.membership_id]); if (Number((await c.query('SELECT count(*) FROM chat_stream_lease WHERE tenant_id=$1 AND member_id=$2', [m.tenant_id, m.membership_id])).rows[0].count) >= 3)
        fail(429, 'CHAT_STREAM_LIMIT'); const lease = randomUUID(); await c.query("INSERT INTO chat_stream_lease VALUES($1,$2,$3,now()+interval '15 seconds')", [m.tenant_id, m.membership_id, lease]); return lease; }); }
    async renewChatStream(current: IdentityContext, lease: string) { return this.run(current, async (c, m) => { if (!(await c.query("UPDATE chat_stream_lease SET expires_at=now()+interval '15 seconds' WHERE tenant_id=$1 AND member_id=$2 AND id=$3 AND expires_at>now()", [m.tenant_id, m.membership_id, lease])).rowCount)
        fail(429, 'CHAT_STREAM_EXPIRED'); }); }
    async closeChatStream(current: IdentityContext, lease: string) { await this.pool?.query('DELETE FROM chat_stream_lease WHERE tenant_id=$1 AND member_id=$2 AND id=$3', [current.tenant_id, current.membership_id, lease]); }
    override async close() { for (const e of this.executions.values())
        e.abort.abort(); await Promise.allSettled([...this.executions.values()].map(e => e.done)); await super.close(); }
}
