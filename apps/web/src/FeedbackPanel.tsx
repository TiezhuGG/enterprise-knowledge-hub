import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Input, List, Select, Space, Tag, Typography } from 'antd';
import type { ChatRun, DocumentVersion, KnowledgeBase, KnowledgeDocument, SessionInfo } from '@zhiheng/contracts';
export const feedbackKinds: Record<string, string> = { missing: '缺少资料', outdated: '资料过期', retrieval: '检索错误', answer: '回答错误', permission: '权限问题', other: '待人工分类' };
const states: Record<string, string> = { open: '待分诊', triaged: '已分诊', in_progress: '处理中', awaiting_validation: '待回归与核验', resolved: '已验证完成', dismissed: '核验后关闭', duplicate: '已核对为重复问题' };
type Item = {
    id: string;
    question: string;
    description: string;
    kind: string;
    priority: string;
    status: string;
    assigned: boolean;
    assignee_id: string | null;
    can_manage: boolean;
    needs_reassignment: boolean;
    etag: string;
    internal_note: string | null;
    regression_id: string | null;
    experiment_id: string | null;
    resolution_document_id: string | null;
    events?: Array<{
        seq: number;
        action: string;
        status: string;
        note: string | null;
        created_at: string;
    }>;
};
const labels: Record<string, string> = { triage: '记录人工分诊', assign: '分派负责人', claim: '由我接手', note: '记录处理进展', link_fix: '关联知识修订', approve_regression: '审核纳入回归', resolve: '验证并完成', dismiss: '人工核验后关闭', duplicate: '核对重复问题', reopen: '重新打开' };
const messages: Record<string, string> = { FEEDBACK_OWNER_REQUIRED: '当前没有可接手的有效负责人，请先由维护者核对资料库管理授权。', FEEDBACK_ASSIGNEE_UNAVAILABLE: '该负责人当前不能管理或读取关联来源，请重新选择。', FEEDBACK_NOT_ASSIGNED_TO_YOU: '请先由有权负责人接手。', FEEDBACK_TRIAGE_REQUIRED: '请先记录人工分诊。', FEEDBACK_REGRESSION_REVIEW_REQUIRED: '请先接手并审核问题及预期结果。', FEEDBACK_REGRESSION_REQUIRED: '请先审核并运行回归。', FEEDBACK_VALIDATION_STALE: '资料、权限或回归结果已变化，请重新核验。', FEEDBACK_REGRESSION_NOT_PASSED: '回归未命中预期资料或发生降级，不能标记为完成。', FEEDBACK_STRATEGY_NOT_ACTIVE: '回归使用的策略尚未正式启用，请完成策略发布后再验证。', FEEDBACK_REPORTER_ACCESS_UNCONFIRMED: '尚未确认报告人有权读取修复结果，不能标记为已恢复。', FEEDBACK_NEW_KNOWLEDGE_REQUIRED: '当前没有可验证的新资料或较新发布版本。', FEEDBACK_FIX_REQUIRED: '请先关联知识补充或修订版本。', FEEDBACK_DUPLICATE_MISMATCH: '目标不属于同一可见资料库、问题摘要不同，或目标本身已合并。', FEEDBACK_RUN_SCOPE_MISMATCH: '会话与所选资料库或问题不匹配，请在对应资料库内手动提交。', FEEDBACK_CHANGED: '工单在回归期间已更新，请刷新后核对；不会自动覆盖。' };
export function FeedbackPanel({ kb, session, onExpired, run, composeOnly = false }: {
    kb: KnowledgeBase;
    session: SessionInfo;
    onExpired: () => void;
    run?: ChatRun;
    composeOnly?: boolean;
}) {
    const manager = kb.capabilities.includes('manage'), [question, setQuestion] = useState(run?.question ?? ''), [description, setDescription] = useState(''), [kind, setKind] = useState('other'), [priority, setPriority] = useState('normal'), [shared, setShared] = useState(false), [rows, setRows] = useState<Item[]>([]), [next, setNext] = useState<string | null>(null), [filter, setFilter] = useState(''), [kindFilter, setKindFilter] = useState(''), [priorityFilter, setPriorityFilter] = useState(''), [selected, setSelected] = useState<Item | null>(null), [action, setAction] = useState('claim'), [note, setNote] = useState(''), [reviewed, setReviewed] = useState(false), [owner, setOwner] = useState<string | undefined>(), [owners, setOwners] = useState<Array<{
        id: string;
        role: string;
    }>>([]), [documents, setDocuments] = useState<KnowledgeDocument[]>([]), [fixDoc, setFixDoc] = useState<string | undefined>(), [versions, setVersions] = useState<DocumentVersion[]>([]), [fixVersion, setFixVersion] = useState<string | undefined>(), [correction, setCorrection] = useState(''), [duplicate, setDuplicate] = useState(''), [expected, setExpected] = useState<string[]>([]), [strategies, setStrategies] = useState<Array<{
        id: string;
        version: number;
        name: string;
    }>>([]), [strategy, setStrategy] = useState<string | undefined>(), [stats, setStats] = useState<any>(null), [report, setReport] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
    const alive = useRef(true), pending = useRef<{
        fingerprint: string;
        key: string;
    } | null>(null);
    async function request(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}) { const r = await fetch(`/api/v1${path}`, { method, signal: AbortSignal.timeout(125000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) {
        if (r.status === 401)
            onExpired();
        throw new Error(messages[v.error?.code] ?? (r.status === 404 ? '反馈或关联来源不可用，或当前权限已变化。' : r.status === 412 ? '记录已更新，请刷新后重新核对。' : r.status === 400 ? '请核对字段，填写至少10字说明并完成必要的分享或审核确认。' : `操作未完成（${v.error?.code ?? r.status}），请刷新记录核对结果。`));
    } return v; }
    function token(fingerprint: string) { if (pending.current?.fingerprint !== fingerprint)
        pending.current = { fingerprint, key: crypto.randomUUID() }; return pending.current.key; }
    async function perform(fn: () => Promise<void>) { setError(''); setBusy(true); try {
        await fn();
    }
    catch (e) {
        if (alive.current) {
            setError((e as Error).message);
            setSelected(null);
            setReport(null);
        }
    }
    finally {
        if (alive.current)
            setBusy(false);
    } }
    async function list(cursor?: string) { const v = await request(`/knowledge-bases/${kb.id}/feedback?limit=20${filter ? `&status=${filter}` : ''}${kindFilter ? `&kind=${kindFilter}` : ''}${priorityFilter ? `&priority=${priorityFilter}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setRows(old => cursor ? [...old, ...v.data] : v.data);
        setNext(v.page.next_cursor);
    } }
    async function refresh() { await list(); if (manager) {
        const s = await request(`/knowledge-bases/${kb.id}/feedback-stats`);
        setStats(s.data);
        const d = await request(`/knowledge-bases/${kb.id}/documents?limit=100`);
        setDocuments(d.data);
        const v = await request(`/knowledge-bases/${kb.id}/retrieval-strategies?limit=100`);
        setStrategies(v.data);
        const active = await request(`/knowledge-bases/${kb.id}/retrieval-strategy`);
        setStrategy(active.data.strategy?.id);
    } }
    async function inspect(id: string) { const v = await request(`/feedback/${id}`); setSelected(v.data); setKind(v.data.kind); setPriority(v.data.priority); setOwner(v.data.assignee_id ?? undefined); setNote(''); setReviewed(false); setReport(null); setFixDoc(undefined); setFixVersion(undefined); setAction(['resolved', 'dismissed', 'duplicate'].includes(v.data.status) ? 'reopen' : v.data.assignee_id === session.identity.membership_id ? 'triage' : 'claim'); if (v.data.can_manage) {
        const o = await request(`/knowledge-bases/${kb.id}/feedback-owners?case_id=${id}`);
        setOwners(o.data);
    } }
    async function create() { const body = { question, description, kind, priority, shared, ...(run ? { run_id: run.id } : {}) }, v = await request(`/knowledge-bases/${kb.id}/feedback`, 'POST', body, { 'Idempotency-Key': token(JSON.stringify(body)) }); pending.current = null; setDescription(''); if (!run)
        setQuestion(''); setShared(false); setMessage(`反馈已登记（${v.data.assigned ? '已绑定负责人' : '等待接手'}），不会自动加入知识库。`); if (!composeOnly) {
        await refresh();
        await inspect(v.data.id);
    } }
    async function chooseFix(value: string) { setFixDoc(value); setFixVersion(undefined); const v = await request(`/documents/${value}/versions?limit=100`); setVersions(v.data); }
    async function operate() { if (!selected)
        return; const body = { action, note, ...(action === 'triage' ? { kind, priority, assignee_id: owner } : {}), ...(action === 'assign' ? { assignee_id: owner } : {}), ...(action === 'link_fix' ? { document_id: fixDoc, version_id: fixVersion, ...(correction.trim() ? { correction_id: correction.trim() } : {}) } : {}), ...(action === 'duplicate' ? { duplicate_of: duplicate.trim() } : {}), ...(['approve_regression', 'dismiss'].includes(action) ? { reviewed } : {}), ...(action === 'approve_regression' ? { expected_document_ids: expected } : {}) }; const v = await request(`/feedback/${selected.id}/actions`, 'POST', body, { 'If-Match': selected.etag, 'Idempotency-Key': token(JSON.stringify([selected.id, body])) }); pending.current = null; setSelected(v.data); if (['resolved', 'dismissed', 'duplicate'].includes(v.data.status)) setAction('reopen'); else if (action === 'reopen') setAction('triage'); setNote(''); setReviewed(false); setReport(null); setMessage('处理状态与审计已保存。'); await refresh(); }
    async function regression() { if (!selected || !strategy)
        return; const body = { strategy_id: strategy }, v = await request(`/feedback/${selected.id}/regression-runs`, 'POST', body, { 'If-Match': selected.etag, 'Idempotency-Key': token(JSON.stringify([selected.id, selected.regression_id, body])) }); pending.current = null; setSelected(v.data.feedback); setReport(v.data.experiment); await refresh(); }
    useEffect(() => { alive.current = true; if (!composeOnly)
        void perform(refresh); return () => { alive.current = false; }; }, []);
    useEffect(() => { if (!composeOnly) {
        setSelected(null);
        void perform(() => list());
    } }, [filter, kindFilter, priorityFilter]);
    const isClosed = selected && ['resolved', 'dismissed', 'duplicate'].includes(selected.status);
    return <Card className="feedback-panel" title={composeOnly ? '分享问题给知识负责人' : manager ? '反馈与知识缺口运营' : '我的反馈与知识缺口'} size="small" extra={!composeOnly && <Button disabled={busy} onClick={() => void perform(refresh)}>刷新运营记录</Button>}><Space direction="vertical" style={{ width: '100%' }}>{error && <Alert role="alert" type="error" showIcon message={error}/>}{message && <Alert role="status" type="success" showIcon message={message}/>}<Typography.Text type="secondary">用户反馈是待核验线索，不会直接写入知识或训练数据。问题与说明只向你和当前有权处理关联来源的维护者开放；内部处理备注不向报告人展示。</Typography.Text><Input.TextArea aria-label="知识缺口问题" value={question} disabled={busy || !!run} maxLength={1200} rows={2} onChange={e => setQuestion(e.target.value)} placeholder="需要核对的业务问题"/><Input.TextArea aria-label="知识缺口说明" value={description} disabled={busy} maxLength={2000} rows={3} onChange={e => setDescription(e.target.value)} placeholder="说明缺少资料、检索/回答错误或权限问题，至少10字"/><Space wrap><Select aria-label="反馈初步分类" value={kind} disabled={busy} onChange={setKind} options={Object.entries(feedbackKinds).map(([value, label]) => ({ value, label }))}/><Select aria-label="反馈优先级" value={priority} disabled={busy} onChange={setPriority} options={[{ value: 'normal', label: '普通优先级' }, { value: 'high', label: '高优先级（需有效负责人）' }]}/></Space><Checkbox checked={shared} disabled={busy} onChange={e => setShared(e.target.checked)}>同意将本问题与说明分享给本资料库有权维护者，不共享整段私有会话</Checkbox><Button loading={busy} disabled={!shared || !question.trim() || description.trim().length < 10} onClick={() => void perform(create)}>提交知识缺口</Button>
 {!composeOnly && <>{manager && stats && <><Descriptions size="small" column={1} items={[{ key: 'total', label: '当前可见有效反馈', children: stats.visible_total }, { key: 'high', label: '高优先级 / 需重新分派', children: `${stats.high_priority} / ${stats.high_needing_reassignment}` }, { key: 'repeat', label: '重复问题组 / 重复提交', children: `${stats.duplicate_groups} / ${stats.repeated_submissions}` }, { key: 'cycle', label: '关闭样本 / 平均处理周期', children: `${stats.closed_count} / ${stats.mean_cycle_ms === null ? '暂无样本' : `${(stats.mean_cycle_ms / 60000).toFixed(1)} 分钟`}` }]}/><Space wrap>{Object.entries(stats.by_kind as Record<string, number>).map(([k, n]) => <Tag key={k}>{feedbackKinds[k]}：{n}</Tag>)}</Space></>}<Space wrap><Select aria-label="反馈状态筛选" value={filter} onChange={setFilter} options={[{ value: '', label: '全部反馈状态' }, ...Object.entries(states).map(([value, label]) => ({ value, label }))]}/><Select aria-label="反馈分类筛选" value={kindFilter} onChange={setKindFilter} options={[{ value: '', label: '全部问题分类' }, ...Object.entries(feedbackKinds).map(([value, label]) => ({ value, label }))]}/><Select aria-label="反馈优先级筛选" value={priorityFilter} onChange={setPriorityFilter} options={[{ value: '', label: '全部优先级' }, { value: 'high', label: '高优先级' }, { value: 'normal', label: '普通优先级' }]}/></Space><List dataSource={rows} locale={{ emptyText: '暂无当前可见反馈' }} renderItem={r => <List.Item actions={[<Button key="inspect" onClick={() => void perform(() => inspect(r.id))}>查看知识缺口</Button>]}><Space direction="vertical"><Typography.Text>{r.question}</Typography.Text><Space wrap><Tag>{feedbackKinds[r.kind]}</Tag><Tag>{states[r.status]}</Tag><Tag>{r.priority === 'high' ? '高优先级' : '普通优先级'}</Tag><Typography.Text>{r.needs_reassignment && manager ? '需要重新分派' : r.assigned ? '已有处理人' : '待接手'}</Typography.Text></Space></Space></List.Item>}/>{next && <Button onClick={() => void perform(() => list(next))}>加载更多知识缺口</Button>}
 {selected && <Card size="small" title="知识缺口处理记录"><Space direction="vertical" style={{ width: '100%' }}><Tag>{states[selected.status]}</Tag><Typography.Text style={{ overflowWrap: 'anywhere' }}>记录 ID：{selected.id}</Typography.Text><pre className="parsed-text">{selected.description}</pre>{selected.can_manage && <><Typography.Text type="secondary">先分诊并确认负责人，再审核回归或关联知识修订。回归不会自动发布策略；完成需要当前已启用策略下的有效结果。仅作人工核验说明时使用“人工核验后关闭”。</Typography.Text>{selected.assignee_id && <Typography.Text>处理人账号：{selected.assignee_id}</Typography.Text>}{selected.internal_note && <pre className="parsed-text">{selected.internal_note}</pre>}<Select aria-label="知识缺口处理动作" value={action} style={{ width: '100%' }} onChange={setAction} options={(isClosed ? ['reopen'] : Object.keys(labels).filter(v => v !== 'reopen')).map(value => ({ value, label: labels[value] }))}/>{action === 'triage' && <Space wrap><Select aria-label="人工分诊类别" value={kind} onChange={setKind} options={Object.entries(feedbackKinds).map(([value, label]) => ({ value, label }))}/><Select aria-label="人工分诊优先级" value={priority} onChange={setPriority} options={[{ value: 'normal', label: '普通优先级' }, { value: 'high', label: '高优先级' }]}/></Space>}{['triage', 'assign'].includes(action) && <Select aria-label="知识缺口负责人" style={{ width: '100%' }} value={owner} onChange={setOwner} options={owners.map(o => ({ value: o.id, label: `${o.role} · ${o.id}` }))}/>} {action === 'link_fix' && <><Select aria-label="关联修订文档" value={fixDoc} style={{ width: '100%' }} onChange={value => void perform(() => chooseFix(value))} options={documents.map(d => ({ value: d.id, label: d.title }))}/><Select aria-label="关联修订版本" value={fixVersion} style={{ width: '100%' }} onChange={setFixVersion} options={versions.map(v => ({ value: v.id, label: `v${v.version_no} · ${v.filename}${v.is_published ? ' · 已发布' : ''}` }))}/><Input aria-label="关联纠错记录 ID" value={correction} onChange={e => setCorrection(e.target.value)} placeholder="可选：版本纠错记录 ID"/></>}{action === 'duplicate' && <Input aria-label="重复问题目标 ID" value={duplicate} onChange={e => setDuplicate(e.target.value)} placeholder="同一问题的目标反馈 ID"/>}{action === 'approve_regression' && <Select aria-label="反馈回归预期文档" style={{ width: '100%' }} mode="multiple" maxCount={5} value={expected} onChange={setExpected} options={documents.filter(d => d.status === 'active').map(d => ({ value: d.id, label: d.title }))} placeholder="选择当前发布文档；空列表只验证应无证据"/>}{['approve_regression', 'dismiss'].includes(action) && <Checkbox checked={reviewed} onChange={e => setReviewed(e.target.checked)}>已人工核对问题、预期结果或关闭依据</Checkbox>}<Input.TextArea aria-label="知识缺口处理说明" value={note} maxLength={2000} rows={3} onChange={e => setNote(e.target.value)} placeholder="至少10字；仅向当前有权维护者显示"/><Button loading={busy} disabled={note.trim().length < 10 || (['approve_regression', 'dismiss'].includes(action) && !reviewed)} onClick={() => void perform(operate)}>提交缺口处理</Button>{selected.regression_id && !isClosed && <><Select aria-label="反馈回归策略" style={{ width: '100%' }} value={strategy} onChange={setStrategy} options={strategies.map(v => ({ value: v.id, label: `v${v.version} · ${v.name}` }))}/><Button loading={busy} disabled={!strategy} onClick={() => void perform(regression)}>运行已审核问题回归</Button></>}{report && <Alert type={report.status === 'completed' ? 'info' : 'warning'} message={report.status === 'completed' ? `回归已记录 · 候选参考覆盖 ${report.report?.rows?.[0]?.candidate?.recall ?? '未知'}` : `回归${report.status === 'running' ? '正在进行' : '未完成'}，请到实验记录核对`} description="结果未通过、过期、权限变化或策略未启用时，不能验证完成。"/>}</>}<List size="small" dataSource={selected.events ?? []} renderItem={e => <List.Item><Space direction="vertical"><Typography.Text>{new Date(e.created_at).toLocaleString()} · {labels[e.action] ?? (e.action === 'created' ? '已登记' : e.action === 'regression_run' ? '记录回归' : '处理记录')} · {states[e.status]}</Typography.Text>{e.note && <Typography.Text>{e.note}</Typography.Text>}</Space></List.Item>}/></Space></Card>}
 </>}</Space></Card>;
}
