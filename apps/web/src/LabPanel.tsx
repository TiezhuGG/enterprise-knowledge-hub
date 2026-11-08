import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, List, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import type { KnowledgeBase, KnowledgeChunk, KnowledgeDocument, SessionInfo } from '@zhiheng/contracts';
type Version = {
    id: string;
    version: number;
    name: string;
    config: object;
    config_hash: string;
};
type Evidence = {
    document_id: string;
    rank: number;
    score: number;
    retrieval?: {
        ranks: Record<string, number>;
        contributions: Record<string, number>;
    };
    rerank?: {
        rank: number;
        original_rank: number;
        score: number;
    };
};
type Side = {
    recall: number;
    mrr: number;
    duration_ms: number;
    meta: {
        degraded: boolean;
        rerank?: {
            status: string;
            reason?: string;
        };
    };
    evidence: Evidence[];
};
type Experiment = {
    id: string;
    candidate_id: string;
    status: string;
    error_code: string | null;
    expired: boolean;
    report: null | {
        passed: boolean;
        sample_count: number;
        baseline: {
            recall: number;
            mrr: number;
            duration_ms: number;
        };
        candidate: {
            recall: number;
            mrr: number;
            duration_ms: number;
        };
        rows: Array<{
            query_hash: string;
            baseline: Side;
            candidate: Side;
        }>;
    };
};
const messages: Record<string, string> = { LAB_SCOPE_CHANGED: '资料、权限或模型配置已变化，旧报告已隐藏，请重新对照。', LAB_BASELINE_CHANGED: '线上基线已变化，请重新评测再启用。', STRATEGY_EVALUATION_REQUIRED: '需要未过期且通过的当前对照报告。', LAB_REPORT_UNAVAILABLE: '报告已过期或未完成，请重新运行。', PROBE_OUTSIDE_SCOPE: '预期文档必须属于当前可见且正式发布的范围。', RESOURCE_VERSION_CHANGED: '资料库配置已变化，请刷新当前策略后重试。', STRATEGY_REVIEW_REQUIRED: '请完成人工核对并填写说明。' };
export function LabPanel({ kb, session, onExpired }: {
    kb: KnowledgeBase;
    session: SessionInfo;
    onExpired: () => void;
}) {
    const [versions, setVersions] = useState<Version[]>([]), [next, setNext] = useState<string | null>(null), [selected, setSelected] = useState(''), [active, setActive] = useState<Version | null>(null), [etag, setEtag] = useState(''), [name, setName] = useState('单变量 top-K 对照'), [config, setConfig] = useState('{"mode":"dense","top_k":10}'), [query, setQuery] = useState(''), [expected, setExpected] = useState<string[]>([]), [documents, setDocuments] = useState<KnowledgeDocument[]>([]), [report, setReport] = useState<Experiment | null>(null), [past, setPast] = useState<Array<{
        id: string;
        status: string;
        error_code: string | null;
    }>>([]), [pastNext, setPastNext] = useState<string | null>(null), [history, setHistory] = useState<Array<{
        id: string;
        version: number;
        created_at: string;
    }>>([]), [historyNext, setHistoryNext] = useState<string | null>(null), [note, setNote] = useState(''), [reviewed, setReviewed] = useState(false), [confirm, setConfirm] = useState(false), [preview, setPreview] = useState<KnowledgeChunk | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const pending = useRef<{
        fingerprint: string;
        key: string;
    } | null>(null), alive = useRef(true);
    async function request(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}) { const r = await fetch(`/api/v1${path}`, { method, signal: AbortSignal.timeout(125000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) {
        if (r.status === 401)
            onExpired();
        throw new Error(messages[v.error?.code] ?? (r.status === 404 ? '实验记录不可用或管理权限已变化。' : r.status === 400 ? '请检查配置 JSON、参数范围与预期文档。' : `操作未完成（${v.error?.code ?? r.status}），请刷新记录核对结果。`));
    } return v; }
    async function perform(fn: () => Promise<void>) { setBusy(true); setError(''); try {
        await fn();
    }
    catch (e) {
        if (alive.current) {
            setError((e as Error).message);
            setReport(null);
            setPreview(null);
        }
    }
    finally {
        if (alive.current)
            setBusy(false);
    } }
    function key(fingerprint: string) { if (pending.current?.fingerprint !== fingerprint)
        pending.current = { fingerprint, key: crypto.randomUUID() }; return pending.current.key; }
    async function current() { const v = await request(`/knowledge-bases/${kb.id}/retrieval-strategy`); if (alive.current) {
        setActive(v.data.strategy);
        setEtag(v.data.etag);
    } }
    async function load(cursor?: string) { const v = await request(`/knowledge-bases/${kb.id}/retrieval-strategies?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setVersions(old => cursor ? [...old, ...v.data] : v.data);
        setNext(v.page.next_cursor);
    } }
    async function runs(cursor?: string) { const v = await request(`/knowledge-bases/${kb.id}/retrieval-experiments?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setPast(old => cursor ? [...old, ...v.data] : v.data);
        setPastNext(v.page.next_cursor);
    } }
    async function publications(cursor?: string) { const v = await request(`/knowledge-bases/${kb.id}/retrieval-strategy-history?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setHistory(old => cursor ? [...old, ...v.data] : v.data);
        setHistoryNext(v.page.next_cursor);
    } }
    async function create() { const body = { name, config: JSON.parse(config) }, v = await request(`/knowledge-bases/${kb.id}/retrieval-strategies`, 'POST', body, { 'Idempotency-Key': key(JSON.stringify(body)) }); pending.current = null; await load(); setSelected(v.data.id); setReport(null); }
    async function compare() { const body = { probes: [{ query, expected_document_ids: expected }] }, v = await request(`/retrieval-strategies/${selected}/experiments`, 'POST', body, { 'Idempotency-Key': key(JSON.stringify([selected, body])) }); pending.current = null; setReport(v.data); setPreview(null); setNote(''); setReviewed(false); setConfirm(false); await runs(); }
    async function inspect(id: string) { const v = await request(`/retrieval-experiments/${id}`); setReport(v.data); setSelected(v.data.candidate_id); setPreview(null); setReviewed(false); setNote(''); setConfirm(false); }
    async function source(row: number, side: string, ordinal: number) { if (!report)
        return; const v = await request(`/retrieval-experiments/${report.id}/source?row=${row}&side=${side}&ordinal=${ordinal}`); setPreview(v.data); }
    async function publish() { if (!report)
        return; const body = { experiment_id: report.id, note, reviewed }, v = await request(`/retrieval-strategies/${report.candidate_id}/publication`, 'POST', body, { 'If-Match': etag, 'Idempotency-Key': key(JSON.stringify([report.candidate_id, body])) }); pending.current = null; setActive(v.data.strategy); setEtag(v.data.etag); setConfirm(false); setReviewed(false); setNote(''); await publications(); }
    async function refresh() { await current(); await load(); await runs(); await publications(); const d = await request(`/knowledge-bases/${kb.id}/documents?status=active&limit=100`); setDocuments(d.data); }
    useEffect(() => { alive.current = true; void perform(refresh); return () => { alive.current = false; }; }, []);
    function evidenceTable(value: Side, row: number, side: string) { return <Table<Evidence> size="small" pagination={false} rowKey={e => `${e.document_id}:${e.rank}`} dataSource={value.evidence} columns={[{ title: '证据 / 排名', render: (_, e) => <Space direction="vertical"><Typography.Text style={{ overflowWrap: 'anywhere' }}>#{e.rank} · {e.document_id}</Typography.Text><Button onClick={() => void perform(() => source(row, side, value.evidence.indexOf(e)))}>核验实验来源</Button></Space> }, { title: '通道 / 重排', render: (_, e) => <Space direction="vertical"><Typography.Text>分数 {e.score.toFixed(5)}</Typography.Text>{e.retrieval && <Typography.Text>语义 #{e.retrieval.ranks.dense ?? '—'} / 词法 #{e.retrieval.ranks.lexical ?? '—'} · 融合贡献 {Object.values(e.retrieval.contributions).reduce((a, b) => a + b, 0).toFixed(6)}</Typography.Text>}{e.rerank && <Typography.Text>重排 #{e.rerank.rank} / 原 #{e.rerank.original_rank} · {e.rerank.score.toFixed(4)}</Typography.Text>}</Space> }]} locale={{ emptyText: '无证据' }}/>; }
    return <Card className="lab-panel" size="small" title="检索实验台与策略发布" extra={<Button disabled={busy} onClick={() => void perform(refresh)}>刷新策略与实验</Button>}><Space direction="vertical" style={{ width: '100%' }}><Typography.Text type="secondary">实验仅使用本资料库当前有权阅读的已发布文档。保存草稿和运行对照不会改变线上策略；启用须通过评测并人工核对。空预期列表表示应无证据。</Typography.Text><Tag>当前策略：{active ? `v${active.version} · ${active.name}` : '请求默认配置'}</Tag>{error && <Alert role="alert" type="error" showIcon message={error}/>}<Input aria-label="检索策略名称" value={name} maxLength={100} onChange={e => setName(e.target.value)}/><Input.TextArea aria-label="检索策略配置" value={config} rows={5} onChange={e => setConfig(e.target.value)} spellCheck={false}/><Typography.Text type="secondary">支持 mode、top_k、min_score、max_characters、hybrid、rerank、context；不接受地址、凭据或权限。建议先只改 top_k，与当前线上基线对照。</Typography.Text><Button loading={busy} onClick={() => void perform(create)} disabled={!name.trim()}>保存新策略草稿</Button><List size="small" dataSource={versions} locale={{ emptyText: '暂无策略版本' }} renderItem={v => <List.Item actions={[<Button key="copy" disabled={busy} onClick={() => { setConfig(JSON.stringify(v.config, null, 2)); setName(`${v.name} 修订`); setSelected(v.id); setReport(null); setPreview(null); }}>复制为新草稿</Button>]}><Typography.Text>v{v.version} · {v.name}{v.id === active?.id ? ' · 当前启用' : ''} · {v.config_hash.slice(0, 12)}</Typography.Text></List.Item>}/>{next && <Button onClick={() => void perform(() => load(next))}>加载更多策略版本</Button>}<Select aria-label="实验候选策略" value={selected || undefined} placeholder="选择候选策略版本" style={{ width: '100%' }} onChange={v => { setSelected(v); setReport(null); setPreview(null); }} options={versions.map(v => ({ value: v.id, label: `v${v.version} · ${v.name}` }))}/><Input.TextArea aria-label="实验检索问题" maxLength={1200} rows={2} value={query} onChange={e => setQuery(e.target.value)}/><Select aria-label="实验预期文档" mode="multiple" maxCount={5} value={expected} style={{ width: '100%' }} placeholder="选择预期文档；留空表示预期无证据" onChange={setExpected} options={documents.map(d => ({ value: d.id, label: d.title }))}/><Button loading={busy} disabled={!selected || !query.trim()} onClick={() => void perform(compare)}>运行策略对照</Button>
 {report && <Card size="small" title="策略对照报告"><Space direction="vertical" style={{ width: '100%' }}><Typography.Text>状态：{report.expired ? '已过期' : report.status === 'completed' ? '已完成' : report.status === 'running' ? '处理中' : '未完成'}{report.error_code ? ` · ${report.error_code}` : ''}</Typography.Text>{report.report && <><Alert showIcon type={report.report.passed ? 'success' : 'warning'} message={report.report.passed ? '样本对照通过，仍需人工核对' : '对照未通过或缺少正例，不能启用'} description={`样本 ${report.report.sample_count}；Recall ${report.report.baseline.recall.toFixed(2)} → ${report.report.candidate.recall.toFixed(2)}；MRR ${report.report.baseline.mrr.toFixed(2)} → ${report.report.candidate.mrr.toFixed(2)}；耗时 ${report.report.baseline.duration_ms} → ${report.report.candidate.duration_ms} ms。费用不等于耗时，未报告的费用不计为零。`}/>{report.report.rows.map((r, index) => <Space key={index} direction="vertical" style={{ width: '100%' }}><Typography.Text>问题摘要 {r.query_hash.slice(0, 12)}</Typography.Text><Typography.Text strong>基线结果</Typography.Text>{evidenceTable(r.baseline, index, 'baseline')}<Typography.Text strong>候选结果</Typography.Text>{r.candidate.meta.rerank && <Typography.Text>重排：{r.candidate.meta.rerank.status}{r.candidate.meta.rerank.reason ? ` · ${r.candidate.meta.rerank.reason}` : ''}</Typography.Text>}{evidenceTable(r.candidate, index, 'candidate')}</Space>)}</>}{report.report?.passed && !report.expired && kb.capabilities.includes('publish') && <><Input.TextArea aria-label="策略发布核对说明" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="核对样本、授权范围及运行成本，至少10字；仅保存摘要"/><Checkbox checked={reviewed} onChange={e => setReviewed(e.target.checked)}>已人工核对对照结果与适用范围</Checkbox><Button disabled={!reviewed || note.trim().length < 10 || busy} onClick={() => setConfirm(true)}>准备启用此策略</Button>{confirm && <Alert type="warning" message="确认替换本资料库当前策略？新请求将使用此版本，运行中的聊天继续使用原已固定版本。" action={<Button loading={busy} onClick={() => void perform(publish)}>确认发布策略</Button>}/>}</>}</Space></Card>}
 <Typography.Text strong>我的实验记录</Typography.Text><List size="small" dataSource={past} locale={{ emptyText: '暂无实验记录' }} renderItem={r => <List.Item actions={[<Button key="inspect" onClick={() => void perform(() => inspect(r.id))}>查看实验报告</Button>]}><Typography.Text>{r.status === 'completed' ? '已完成' : r.status === 'running' ? '处理中' : '未完成'}{r.error_code ? ` · ${r.error_code}` : ''}</Typography.Text></List.Item>}/>{pastNext && <Button onClick={() => void perform(() => runs(pastNext))}>加载更多实验记录</Button>}<Typography.Text strong>策略发布历史</Typography.Text><List size="small" dataSource={history} locale={{ emptyText: '尚未启用策略' }} renderItem={r => <List.Item>v{r.version} · {new Date(r.created_at).toLocaleString()}</List.Item>}/>{historyNext && <Button onClick={() => void perform(() => publications(historyNext))}>加载更多策略发布记录</Button>}
 <Modal title="实验来源核验" open={!!preview} footer={<Button onClick={() => setPreview(null)}>关闭</Button>} onCancel={() => setPreview(null)}>{preview && <><Typography.Text>{preview.heading_path.join(' / ')}</Typography.Text><pre className="parsed-text">{preview.text}</pre></>}</Modal></Space></Card>;
}
