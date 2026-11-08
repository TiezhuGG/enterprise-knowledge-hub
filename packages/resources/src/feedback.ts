import { createHmac, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext } from '@zhiheng/contracts';
import { LabStore } from './lab';
import { fail, ResourceError } from './policy';
import { digest } from './embedding';
import type { ListInput } from './store';
export const GAP_KINDS = ['missing', 'outdated', 'retrieval', 'answer', 'permission', 'other'] as const;
export const GAP_STATES = ['open', 'triaged', 'in_progress', 'awaiting_validation', 'resolved', 'dismissed', 'duplicate'] as const;
export const feedbackEtag = (r: any) => `"feedback:${r.id}:${r.row_version}"`;
export const normalizeFeedbackQuestion = (s: string) => s.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
export interface FeedbackInput {
    question: string;
    description: string;
    kind: typeof GAP_KINDS[number];
    priority: 'normal' | 'high';
    shared: boolean;
    run_id?: string;
    document_id?: string;
    version_id?: string;
}
export interface FeedbackChange {
    action: 'triage' | 'assign' | 'claim' | 'note' | 'link_fix' | 'approve_regression' | 'resolve' | 'dismiss' | 'duplicate' | 'reopen';
    note: string;
    reviewed?: boolean;
    kind?: typeof GAP_KINDS[number];
    priority?: 'normal' | 'high';
    assignee_id?: string;
    duplicate_of?: string;
    document_id?: string;
    version_id?: string;
    correction_id?: string;
    expected_document_ids?: string[];
}
export interface FeedbackList extends ListInput {
    kind?: string;
    priority?: string;
}
const closed = (s: string) => ['resolved', 'dismissed', 'duplicate'].includes(s);
const text = (v: unknown, min: number, max: number) => { if (typeof v !== 'string' || v.trim().length < min || v.length > max)
    fail(400, 'INVALID_FEEDBACK_TEXT'); return v.trim(); };
export class FeedbackStore extends LabStore {
    private questionKey(tenant: string, kb: string, question: string) { if (this.cursorSecret.length < 32)
        fail(503, 'FEEDBACK_KEY_UNAVAILABLE'); return createHmac('sha256', this.cursorSecret).update(JSON.stringify([tenant, kb, normalizeFeedbackQuestion(question)])).digest('hex'); }
    private async feedbackRequest(c: PoolClient, m: IdentityContext, key: string, payload: unknown) { if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key))
        fail(400, 'IDEMPOTENCY_KEY_REQUIRED'); const kh = digest(key), ph = digest(JSON.stringify(payload)); await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`feedback:${m.tenant_id}:${m.membership_id}:${kh}`]); const old = (await c.query('SELECT * FROM feedback_request WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0]; if (old && old.payload_hash !== ph)
        fail(409, 'IDEMPOTENCY_CONFLICT'); return { kh, ph, old: old?.case_id }; }
    private async rememberFeedback(c: PoolClient, m: IdentityContext, r: any, id: string) { await c.query('INSERT INTO feedback_request VALUES($1,$2,$3,$4,$5)', [m.tenant_id, m.membership_id, r.kh, r.ph, id]); }
    private async feedbackRefs(c: PoolClient, tenant: string, id: string) { return (await c.query('SELECT document_id,version_id,generation_id,origin FROM feedback_reference WHERE tenant_id=$1 AND case_id=$2 ORDER BY document_id,version_id', [tenant, id])).rows; }
    private async feedbackAccess(c: PoolClient, m: IdentityContext, id: string, manage = false, lock = false) { let r = (await c.query('SELECT * FROM feedback_case WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id])).rows[0]; if (!r)
        fail(404, 'RESOURCE_UNAVAILABLE'); const kb = await this.kb(c, m, r.kb_id, 'read', lock), canManage = kb.capabilities.includes('manage'); if (manage ? !canManage : !canManage && r.reporter_id !== m.membership_id)
        fail(404, 'RESOURCE_UNAVAILABLE'); if (!(await c.query('SELECT feedback_case_readable($1,$2,$3) AS allowed', [m.tenant_id, id, m.membership_id])).rows[0].allowed)
        fail(404, 'RESOURCE_UNAVAILABLE'); const refs = await this.feedbackRefs(c, m.tenant_id, id); for (const ref of refs)
        await this.version(c, m, ref.document_id, ref.version_id); if (lock)
        r = (await c.query('SELECT * FROM feedback_case WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [m.tenant_id, id])).rows[0]; return { r, refs, canManage }; }
    private async feedbackEvent(c: PoolClient, m: IdentityContext, r: any, action: string, note: string, request: string) { await c.query('INSERT INTO feedback_event(tenant_id,case_id,seq,member_id,action,status,note) VALUES($1,$2,$3,$4,$5,$6,$7)', [m.tenant_id, r.id, r.row_version, m.membership_id, action, r.status, note]); await this.audit(c, m, r.id, `feedback.${action}`, request); }
    private async feedbackView(c: PoolClient, m: IdentityContext, r: any, manage: boolean, details = false) { const valid = r.assignee_id ? Boolean((await c.query("SELECT feedback_resource_action($1,$2,NULL,$3,'manage') AND feedback_case_readable($1,$4,$3) AS valid", [m.tenant_id, r.kb_id, r.assignee_id, r.id])).rows[0].valid) : false; return { id: r.id, kb_id: r.kb_id, question: r.question, description: r.description, kind: r.kind, priority: r.priority, status: r.status, assigned: !!r.assignee_id, needs_reassignment: !valid, can_manage: manage, assignee_id: manage ? r.assignee_id : null, triaged_at: r.triaged_at, duplicate_of: manage ? r.duplicate_of : null, internal_note: manage ? r.internal_note : null, correction_id: manage ? r.correction_id : null, resolution_document_id: manage ? r.resolution_document_id : null, regression_id: manage ? r.regression_id : null, experiment_id: manage ? r.experiment_id : null, closure_evidence: manage ? r.closure_evidence : null, row_version: r.row_version, etag: feedbackEtag(r), created_at: r.created_at, updated_at: r.updated_at, closed_at: r.closed_at, content_expires_at: r.content_expires_at, ...(details ? { references: manage ? await this.feedbackRefs(c, m.tenant_id, r.id) : [], events: (await c.query('SELECT seq,member_id,action,status,note,created_at FROM feedback_event WHERE tenant_id=$1 AND case_id=$2 ORDER BY seq DESC LIMIT 100', [m.tenant_id, r.id])).rows.reverse().map(e => ({ ...e, member_id: manage ? e.member_id : null, note: manage ? e.note : null })) } : {}) }; }
    private async managers(c: PoolClient, m: IdentityContext, kb: string, refs: any[], caseId?: string) { const rows = (await c.query("SELECT p.* FROM membership p JOIN knowledge_base k ON k.tenant_id=p.tenant_id AND k.id=$2 WHERE p.tenant_id=$1 AND p.status='active' AND p.role IN ('operator','admin') AND feedback_resource_action($1,$2,NULL,p.id,'manage') AND feedback_resource_action($1,$2,NULL,p.id,'read') ORDER BY (p.id=k.owner_id) DESC,p.id LIMIT 100", [m.tenant_id, kb])).rows, result = []; for (const row of rows) {
        const identity = await this.member(c, { ...m, membership_id: row.id, actor_id: row.actor_id });
        try {
            for (const ref of refs)
                await this.version(c, identity, ref.document_id, ref.version_id);
            if (caseId && !(await c.query('SELECT feedback_case_readable($1,$2,$3) AS allowed', [m.tenant_id, caseId, row.id])).rows[0].allowed)
                continue;
            result.push({ id: row.id, role: row.role });
        }
        catch (e) {
            if (e instanceof ResourceError && [401, 404].includes(e.status))
                continue;
            throw e;
        }
    } return result; }
    feedbackOwners(current: IdentityContext, kb: string, id?: string) { return this.run(current, async (c, m) => { const k = await this.kb(c, m, kb, 'manage'); if (!k.capabilities.includes('read'))
        fail(404, 'RESOURCE_UNAVAILABLE'); const p = id ? await this.feedbackAccess(c, m, id, true) : null; if (p && p.r.kb_id !== kb)
        fail(404, 'RESOURCE_UNAVAILABLE'); return this.managers(c, m, kb, p?.refs ?? [], id); }); }
    async createFeedback(current: IdentityContext, kb: string, input: FeedbackInput, key: string, request: string) {
        const question = text(input.question, 1, 1200), description = text(input.description, 10, 2000);
        if (input.shared !== true)
            fail(400, 'FEEDBACK_SHARING_REQUIRED');
        if (!GAP_KINDS.includes(input.kind) || !['normal', 'high'].includes(input.priority) || Boolean(input.document_id) !== Boolean(input.version_id))
            fail(400, 'INVALID_FEEDBACK_FIELDS');
        if (input.run_id) {
            const run = await this.chatRun(current, input.run_id);
            if (['running', 'restricted', 'expired'].includes(run.status))
                fail(409, 'FEEDBACK_RUN_UNAVAILABLE');
        }
        return this.run(current, async (c, m) => {
            const req = await this.feedbackRequest(c, m, key, ['create', kb, input]);
            await this.kb(c, m, kb, 'read', true);
            if (req.old) {
                const p = await this.feedbackAccess(c, m, req.old);
                return this.feedbackView(c, m, p.r, p.canManage, true);
            }
            const refs: any[] = [];
            let expires = new Date(Date.now() + 30 * 86400000);
            if (input.run_id) {
                const r = (await c.query('SELECT r.* FROM chat_run r JOIN conversation v ON v.tenant_id=r.tenant_id AND v.id=r.conversation_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.member_id=$3 AND r.content_purged_at IS NULL AND r.content_expires_at>clock_timestamp() AND v.deleted_at IS NULL FOR SHARE OF r,v', [m.tenant_id, input.run_id, m.membership_id])).rows[0];
                if (!r || r.status === 'running' || r.input.kb_ids?.length !== 1 || r.input.kb_ids[0] !== kb || normalizeFeedbackQuestion(r.input.query) !== normalizeFeedbackQuestion(question))
                    fail(409, 'FEEDBACK_RUN_SCOPE_MISMATCH');
                expires = new Date(Math.min(expires.getTime(), r.content_expires_at.getTime()));
                for (const d of r.dependencies) {
                    const doc = await this.doc(c, m, d.document_id, 'read');
                    if (doc.kb_id !== kb)
                        fail(409, 'FEEDBACK_RUN_SCOPE_MISMATCH');
                    await this.version(c, m, d.document_id, d.version_id);
                    if (!refs.some(ref => ref.document_id === d.document_id && ref.version_id === d.version_id))
                        refs.push({ document_id: d.document_id, version_id: d.version_id, generation_id: d.generation_id });
                }
            }
            if (input.document_id) {
                const doc = await this.doc(c, m, input.document_id, 'read');
                if (doc.kb_id !== kb)
                    fail(404, 'RESOURCE_UNAVAILABLE');
                await this.version(c, m, input.document_id, input.version_id!);
                if (!refs.some(r => r.document_id === input.document_id && r.version_id === input.version_id))
                    refs.push({ document_id: input.document_id, version_id: input.version_id, generation_id: null });
            }
            const owners = await this.managers(c, m, kb, refs), owner = owners[0]?.id ?? null;
            if (input.priority === 'high' && !owner)
                fail(409, 'FEEDBACK_OWNER_REQUIRED');
            const r = (await c.query('INSERT INTO feedback_case(tenant_id,id,kb_id,reporter_id,run_id,question,description,question_hash,kind,priority,assignee_id,content_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [m.tenant_id, randomUUID(), kb, m.membership_id, input.run_id ?? null, question, description, this.questionKey(m.tenant_id, kb, question), input.kind, input.priority, owner, expires])).rows[0];
            for (const ref of refs)
                await c.query('INSERT INTO feedback_reference(tenant_id,case_id,document_id,version_id,generation_id) VALUES($1,$2,$3,$4,$5)', [m.tenant_id, r.id, ref.document_id, ref.version_id, ref.generation_id]);
            await this.feedbackEvent(c, m, r, 'created', '用户明确分享并提交反馈；类别尚待人工分诊。', request);
            await this.rememberFeedback(c, m, req, r.id);
            return this.feedbackView(c, m, r, (await this.kb(c, m, kb, 'read')).capabilities.includes('manage'), true);
        });
    }
    listFeedback(current: IdentityContext, kb: string, input: FeedbackList) { return this.run(current, async (c, m) => { const k = await this.kb(c, m, kb, 'read'), manage = k.capabilities.includes('manage'), scope = super.scope(m, input, `feedback:${kb}:${manage}`), after = this.cursor(input, scope), rows = (await c.query('SELECT * FROM feedback_case f WHERE tenant_id=$1 AND kb_id=$2 AND ($3 OR reporter_id=$4) AND feedback_case_readable($1,f.id,$4) AND ($5::text IS NULL OR status=$5) AND ($6::text IS NULL OR kind=$6) AND ($7::text IS NULL OR priority=$7) AND ($8::timestamptz IS NULL OR (created_at,id)<($8::timestamptz,$9::uuid)) ORDER BY created_at DESC,id DESC LIMIT $10', [m.tenant_id, kb, manage, m.membership_id, input.status ?? null, input.kind ?? null, input.priority ?? null, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows, p = this.page(rows, input, scope); return { ...p, data: await Promise.all(p.data.map(r => this.feedbackView(c, m, r, manage))) }; }); }
    getFeedback(current: IdentityContext, id: string) { return this.run(current, async (c, m) => { const p = await this.feedbackAccess(c, m, id); return this.feedbackView(c, m, p.r, p.canManage, true); }); }
    feedbackStats(current: IdentityContext, kb: string) { return this.run(current, async (c, m) => { await this.kb(c, m, kb, 'manage'); const rows = (await c.query('SELECT id,kind,priority,status,question_hash,assignee_id,extract(epoch from (closed_at-created_at))*1000 AS duration_ms,feedback_resource_action($1,$2,NULL,assignee_id,\'manage\') AND feedback_case_readable($1,id,assignee_id) AS valid_owner FROM feedback_case WHERE tenant_id=$1 AND kb_id=$2 AND feedback_case_readable($1,id,$3) LIMIT 10001', [m.tenant_id, kb, m.membership_id])).rows; if (rows.length > 10000)
        fail(422, 'FEEDBACK_STATS_TOO_LARGE'); const durations = rows.filter(r => r.duration_ms !== null).map(r => Number(r.duration_ms)), counts = (key: string) => rows.reduce((a: Record<string, number>, r) => { a[r[key]] = (a[r[key]] ?? 0) + 1; return a; }, {}), groups = Object.values(counts('question_hash')) as number[]; return { visible_total: rows.length, by_kind: counts('kind'), by_status: counts('status'), high_priority: rows.filter(r => r.priority === 'high').length, high_needing_reassignment: rows.filter(r => r.priority === 'high' && !closed(r.status) && !r.valid_owner).length, duplicate_groups: groups.filter(n => n > 1).length, repeated_submissions: groups.reduce((n, v) => n + Math.max(0, v - 1), 0), closed_count: durations.length, mean_cycle_ms: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null }; }); }
    private async publishedFeedbackDoc(c: PoolClient, m: IdentityContext, id: string) { const d = await this.doc(c, m, id, 'read'), row = (await c.query("SELECT d.*,v.version_no,v.created_at AS version_created_at,a.scan_status,g.chunk_count FROM document d JOIN document_version v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.id=d.published_version_id JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id JOIN index_generation g ON g.tenant_id=d.tenant_id AND g.id=d.published_generation_id AND g.version_id=v.id WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='active' AND a.scan_status='clean' AND g.status='ready' AND g.indexed_count=g.chunk_count AND (SELECT count(*) FROM index_receipt r WHERE r.tenant_id=g.tenant_id AND r.generation_id=g.id)=g.chunk_count FOR SHARE OF a,g", [m.tenant_id, id])).rows[0]; if (!row)
        fail(409, 'FEEDBACK_KNOWLEDGE_NOT_READY'); return { ...row, kb_id: d.kb_id }; }
    private async addFeedbackRef(c: PoolClient, m: IdentityContext, r: any, doc: string, version: string, generation: string | null) { await c.query("INSERT INTO feedback_reference(tenant_id,case_id,document_id,version_id,generation_id,origin) VALUES($1,$2,$3,$4,$5,'remediation') ON CONFLICT DO NOTHING", [m.tenant_id, r.id, doc, version, generation]); }
    async changeFeedback(current: IdentityContext, id: string, input: FeedbackChange, etag: string | undefined, key: string, request: string) {
        const note = text(input.note, 10, 2000);
        return this.run(current, async (c, m) => {
            const req = await this.feedbackRequest(c, m, key, ['change', id, input]), p = await this.feedbackAccess(c, m, id, true, true), r = p.r;
            if (req.old) {
                if (req.old !== id)
                    fail(409, 'IDEMPOTENCY_CONFLICT');
                return this.feedbackView(c, m, r, true, true);
            }
            if (!etag)
                fail(428, 'IF_MATCH_REQUIRED');
            if (etag !== feedbackEtag(r))
                fail(412, 'RESOURCE_VERSION_CHANGED');
            const patch: Record<string, unknown> = { internal_note: note };
            if (input.action === 'reopen') {
                if (!closed(r.status))
                    fail(409, 'FEEDBACK_NOT_CLOSED');
                Object.assign(patch, { status: 'open', assignee_id: m.membership_id, triaged_by: null, triaged_at: null, regression_id: null, experiment_id: null, closure_evidence: null, closed_at: null, duplicate_of: null });
            }
            else {
                if (closed(r.status))
                    fail(409, 'FEEDBACK_CLOSED');
                if (input.action === 'triage') {
                    if (!input.kind || !GAP_KINDS.includes(input.kind) || !input.priority || !['normal', 'high'].includes(input.priority))
                        fail(400, 'INVALID_FEEDBACK_TRIAGE');
                    const owner = input.assignee_id ?? r.assignee_id ?? m.membership_id;
                    if (!(await this.managers(c, m, r.kb_id, p.refs, id)).some(v => v.id === owner))
                        fail(409, 'FEEDBACK_ASSIGNEE_UNAVAILABLE');
                    Object.assign(patch, { kind: input.kind, priority: input.priority, assignee_id: owner, status: 'triaged', triaged_by: m.membership_id, triaged_at: new Date(), regression_id: null, experiment_id: null, closure_evidence: null });
                }
                else if (input.action === 'assign' || input.action === 'claim') {
                    const owner = input.action === 'claim' ? m.membership_id : input.assignee_id;
                    if (!owner || !(await this.managers(c, m, r.kb_id, p.refs, id)).some(v => v.id === owner))
                        fail(409, 'FEEDBACK_ASSIGNEE_UNAVAILABLE');
                    Object.assign(patch, { assignee_id: owner, status: r.triaged_at ? 'in_progress' : 'open', ...(r.assignee_id !== owner ? { regression_id: null, experiment_id: null } : {}) });
                }
                else if (input.action === 'note') { }
                else {
                    if (r.assignee_id !== m.membership_id)
                        fail(409, 'FEEDBACK_NOT_ASSIGNED_TO_YOU');
                    if (!r.triaged_at)
                        fail(409, 'FEEDBACK_TRIAGE_REQUIRED');
                    if (input.action === 'link_fix') {
                        if (!input.document_id || !input.version_id)
                            fail(400, 'FEEDBACK_FIX_REQUIRED');
                        const d = await this.doc(c, m, input.document_id, 'write');
                        if (d.kb_id !== r.kb_id)
                            fail(404, 'RESOURCE_UNAVAILABLE');
                        await this.version(c, m, input.document_id, input.version_id);
                        if (input.correction_id) {
                            const x = (await c.query('SELECT * FROM correction_case WHERE tenant_id=$1 AND id=$2 AND document_id=$3', [m.tenant_id, input.correction_id, input.document_id])).rows[0];
                            if (!x)
                                fail(404, 'RESOURCE_UNAVAILABLE');
                        }
                        await this.addFeedbackRef(c, m, r, input.document_id, input.version_id, null);
                        Object.assign(patch, { resolution_document_id: input.document_id, correction_id: input.correction_id ?? null, status: 'awaiting_validation', experiment_id: null });
                    }
                    else if (input.action === 'approve_regression') {
                        if (input.reviewed !== true || !Array.isArray(input.expected_document_ids) || input.expected_document_ids.length > 5 || new Set(input.expected_document_ids).size !== input.expected_document_ids.length)
                            fail(400, 'FEEDBACK_REGRESSION_REVIEW_REQUIRED');
                        for (const doc of input.expected_document_ids) {
                            const d = await this.publishedFeedbackDoc(c, m, doc);
                            if (d.kb_id !== r.kb_id)
                                fail(404, 'RESOURCE_UNAVAILABLE');
                            await this.addFeedbackRef(c, m, r, d.id, d.published_version_id, d.published_generation_id);
                        }
                        const approval = randomUUID();
                        await c.query('INSERT INTO feedback_regression(tenant_id,id,case_id,reviewer_id,question_hash,expected_document_ids,review_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [m.tenant_id, approval, id, m.membership_id, r.question_hash, input.expected_document_ids, digest(note)]);
                        Object.assign(patch, { regression_id: approval, experiment_id: null, status: 'awaiting_validation' });
                    }
                    else if (input.action === 'duplicate') {
                        if (!input.duplicate_of || input.duplicate_of === id)
                            fail(400, 'INVALID_FEEDBACK_DUPLICATE');
                        const target = (await c.query('SELECT kb_id FROM feedback_case WHERE tenant_id=$1 AND id=$2', [m.tenant_id, input.duplicate_of])).rows[0];
                        if (!target || target.kb_id !== r.kb_id)
                            fail(404, 'RESOURCE_UNAVAILABLE');
                        const other = await this.feedbackAccess(c, m, input.duplicate_of, true);
                        if (other.r.kb_id !== r.kb_id || other.r.question_hash !== r.question_hash || other.r.status === 'duplicate')
                            fail(409, 'FEEDBACK_DUPLICATE_MISMATCH');
                        Object.assign(patch, { status: 'duplicate', duplicate_of: other.r.id, closed_at: new Date(), closure_evidence: { type: 'reviewed_duplicate', review_hash: digest(note) } });
                    }
                    else if (input.action === 'dismiss') {
                        if (input.reviewed !== true)
                            fail(400, 'FEEDBACK_REVIEW_REQUIRED');
                        Object.assign(patch, { status: 'dismissed', closed_at: new Date(), closure_evidence: { type: 'human_review', category: r.kind, review_hash: digest(note), access_changed: false } });
                    }
                    else if (input.action === 'resolve') {
                        if (!r.regression_id || !r.experiment_id)
                            fail(409, 'FEEDBACK_REGRESSION_REQUIRED');
                        const approval = (await c.query('SELECT * FROM feedback_regression WHERE tenant_id=$1 AND id=$2', [m.tenant_id, r.regression_id])).rows[0], experiment = (await c.query("SELECT * FROM retrieval_experiment WHERE tenant_id=$1 AND id=$2 AND member_id=$3 AND status='completed' AND expires_at>clock_timestamp()", [m.tenant_id, r.experiment_id, m.membership_id])).rows[0];
                        if (!approval || approval.question_hash !== r.question_hash || !experiment || experiment.scope_hash !== (await this.labFingerprint(c, m, r.kb_id)).hash)
                            fail(409, 'FEEDBACK_VALIDATION_STALE');
                        const row = experiment.report.rows?.[0];
                        if (!row || experiment.report.rows.length !== 1 || row.query_hash !== digest(r.question) || JSON.stringify(row.expected_document_ids) !== JSON.stringify(approval.expected_document_ids) || row.candidate.meta.degraded || row.candidate.recall !== 1)
                            fail(409, 'FEEDBACK_REGRESSION_NOT_PASSED');
                        if ((await c.query('SELECT active_strategy_id FROM knowledge_base WHERE tenant_id=$1 AND id=$2', [m.tenant_id, r.kb_id])).rows[0].active_strategy_id !== experiment.candidate_id)
                            fail(409, 'FEEDBACK_STRATEGY_NOT_ACTIVE');
                        let reporter: IdentityContext;
                        try {
                            const actor = (await c.query('SELECT actor_id FROM membership WHERE tenant_id=$1 AND id=$2', [m.tenant_id, r.reporter_id])).rows[0];
                            reporter = await this.member(c, { ...m, membership_id: r.reporter_id, actor_id: actor?.actor_id });
                            await this.kb(c, reporter, r.kb_id, 'read');
                            for (const doc of approval.expected_document_ids)
                                await this.publishedFeedbackDoc(c, reporter, doc);
                        }
                        catch (e) {
                            if (e instanceof ResourceError && [401, 404].includes(e.status))
                                fail(409, 'FEEDBACK_REPORTER_ACCESS_UNCONFIRMED');
                            throw e;
                        }
                        if (r.kind === 'permission' && !approval.expected_document_ids.length)
                            fail(409, 'FEEDBACK_ACCESS_REVIEW_REQUIRED');
                        let knowledge: any = null;
                        if (['missing', 'outdated'].includes(r.kind)) {
                            if (!r.resolution_document_id)
                                fail(409, 'FEEDBACK_FIX_REQUIRED');
                            knowledge = await this.publishedFeedbackDoc(c, m, r.resolution_document_id);
                            if (!approval.expected_document_ids.includes(knowledge.id)) fail(409, 'FEEDBACK_FIX_REQUIRED');
                            await this.publishedFeedbackDoc(c, reporter, knowledge.id);
                            const origins = p.refs.filter(ref => ref.origin === 'reported' && ref.document_id === knowledge.id);
                            if (origins.some(ref => ref.version_id === knowledge.published_version_id) || (!origins.length && knowledge.version_created_at < r.created_at))
                                fail(409, 'FEEDBACK_NEW_KNOWLEDGE_REQUIRED');
                        }
                        Object.assign(patch, { status: 'resolved', closed_at: new Date(), closure_evidence: { type: 'current_regression', experiment_id: experiment.id, strategy_id: experiment.candidate_id, question_hash: r.question_hash, knowledge: knowledge ? { document_id: knowledge.id, version_id: knowledge.published_version_id, generation_id: knowledge.published_generation_id } : null, review_hash: digest(note) } });
                    }
                    else
                        fail(400, 'INVALID_FEEDBACK_ACTION');
                }
            }
            const entries = Object.entries(patch), updated = (await c.query(`UPDATE feedback_case SET ${entries.map(([k], i) => `${k}=$${i + 3}`).join(',')},row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [m.tenant_id, id, ...entries.map(([, v]) => v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)])).rows[0];
            await this.feedbackEvent(c, m, updated, input.action, note, request);
            await this.rememberFeedback(c, m, req, id);
            return this.feedbackView(c, m, updated, true, true);
        });
    }
    async runFeedbackRegression(current: IdentityContext, id: string, strategy: string, etag: string | undefined, key: string, request: string, signal = AbortSignal.timeout(120000)) { if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key))
        fail(400, 'IDEMPOTENCY_KEY_REQUIRED'); const before = await this.run(current, async (c, m) => { const p = await this.feedbackAccess(c, m, id, true); if (p.r.assignee_id !== m.membership_id || !p.r.triaged_at || !p.r.regression_id)
        fail(409, 'FEEDBACK_REGRESSION_REVIEW_REQUIRED'); const old = (await c.query("SELECT e.id,e.candidate_id FROM strategy_request q JOIN retrieval_experiment e ON e.tenant_id=q.tenant_id AND e.id=(q.result->>'id')::uuid WHERE q.tenant_id=$1 AND q.member_id=$2 AND q.key_hash=$3", [m.tenant_id, m.membership_id, digest(`fg-${digest(key)}`)])).rows[0]; if (old && p.r.experiment_id === old.id) {
        if (old.candidate_id !== strategy)
            fail(409, 'IDEMPOTENCY_CONFLICT');
        return { replay: true, r: p.r, report: old.id };
    } if (!etag)
        fail(428, 'IF_MATCH_REQUIRED'); if (etag !== feedbackEtag(p.r))
        fail(412, 'RESOURCE_VERSION_CHANGED'); if (closed(p.r.status))
        fail(409, 'FEEDBACK_CLOSED'); const a = (await c.query('SELECT * FROM feedback_regression WHERE tenant_id=$1 AND id=$2', [m.tenant_id, p.r.regression_id])).rows[0], v = (await c.query('SELECT kb_id FROM retrieval_strategy WHERE tenant_id=$1 AND id=$2', [m.tenant_id, strategy])).rows[0]; if (!a || !v || v.kb_id !== p.r.kb_id)
        fail(404, 'RESOURCE_UNAVAILABLE'); return { r: p.r, approval: a }; }); if (before.replay)
        return { feedback: await this.getFeedback(current, id), experiment: await this.getExperiment(current, before.report!) }; const report = await this.runExperiment(current, strategy, [{ query: before.r.question, expected_document_ids: before.approval!.expected_document_ids }], `fg-${digest(key)}`, request, signal); if (report.status !== 'completed')
        return { feedback: await this.getFeedback(current, id), experiment: report }; return this.run(current, async (c, m) => { const p = await this.feedbackAccess(c, m, id, true, true); if (p.r.row_version !== before.r.row_version || p.r.regression_id !== before.approval!.id)
        fail(409, 'FEEDBACK_CHANGED'); const updated = (await c.query("UPDATE feedback_case SET experiment_id=$3,status='awaiting_validation',row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [m.tenant_id, id, report.id])).rows[0]; await this.feedbackEvent(c, m, updated, 'regression_run', '已记录受控回归结果；不自动发布策略或知识。', request); return { feedback: await this.feedbackView(c, m, updated, true, true), experiment: report }; }); }
}
