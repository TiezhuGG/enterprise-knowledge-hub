import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, List, Modal, Select, Space, Tag, Typography } from 'antd';
import type { KnowledgeBase, SessionInfo } from '@zhiheng/contracts';
type Release = {
    id: string;
    status: string;
    profile_ref: string;
    etag: string;
    proof?: {
        evaluation: {
            non_regression: boolean;
            baseline: {
                recall_at_5: number;
                mrr: number;
            };
            candidate: {
                recall_at_5: number;
                mrr: number;
            };
        };
    };
    items?: Array<{
        document_id: string;
        version_id: string;
        candidate_generation_id: string | null;
        error_code: string | null;
    }>;
};
const states: Record<string, string> = { building: '影子构建 / 待核验', verified: '核验通过，等待发布', active: '已切换', rolled_back: '已回滚索引', cancelled: '已取消计划' };
const errors: Record<string, string> = { RELEASE_CATCHUP_REQUIRED: '发布范围已变化，请先追赶构建并重新核验。', RELEASE_BUILD_INCOMPLETE: '影子代际尚未全部就绪，请查看处理任务后重试。', PUBLICATION_SCOPE_CHANGED: '权限、索引或文档已变化，请刷新并重新核验。', ROLLBACK_SCOPE_CHANGED: '当前已发布内容发生变化，不能恢复旧内容；请为当前版本创建新重建计划。', INDEX_READBACK_FAILED: '索引读回失败，保持当前发布指针。', QUALITY_REVIEW_REQUIRED: '请先完成质量与权限核对，并填写说明。', RELEASE_VERIFICATION_REQUIRED: '需要重新完成完整核验与对照。', INDEX_PROFILE_UNAVAILABLE: '维护者尚未配置所需模型空间。', RESOURCE_VERSION_CHANGED: '记录已变化，请刷新后重试。' };
export function ReleasesPanel({ kb, session, onExpired }: {
    kb: KnowledgeBase;
    session: SessionInfo;
    onExpired: () => void;
}) {
    const [profiles, setProfiles] = useState<Array<{
        ref: string;
        model: string;
        dimension: number;
    }>>([]), [ref, setRef] = useState(''), [rows, setRows] = useState<Release[]>([]), [next, setNext] = useState<string | null>(null), [detail, setDetail] = useState<Release | null>(null), [probes, setProbes] = useState(''), [note, setNote] = useState(''), [reviewed, setReviewed] = useState(false), [confirm, setConfirm] = useState<'activate' | 'rollback' | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const alive = useRef(true), pending = useRef<{
        fingerprint: string;
        key: string;
    } | null>(null);
    async function request(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}) { const r = await fetch(`/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, ...headers }, signal: AbortSignal.timeout(120000), ...(body ? { body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) {
        if (r.status === 401)
            onExpired();
        throw new Error(errors[v.error?.code] ?? (r.status === 404 ? '记录不可用或发布权限已变化。' : r.status === 400 ? '请检查问题样本与核对说明。' : `操作未完成（${v.error?.code ?? r.status}），请刷新记录核对结果。`));
    } return v; }
    async function run(fn: () => Promise<void>) { setError(''); setBusy(true); try {
        await fn();
    }
    catch (e) {
        if (alive.current)
            setError((e as Error).message);
    }
    finally {
        if (alive.current)
            setBusy(false);
    } }
    async function load(cursor?: string) { const v = await request(`/knowledge-bases/${kb.id}/index-releases?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setRows(old => cursor ? [...old, ...v.data] : v.data);
        setNext(v.page.next_cursor);
    } }
    async function inspect(id: string) { const v = await request(`/index-releases/${id}`); if (alive.current)
        setDetail(v.data); }
    function key(fingerprint: string) { if (pending.current?.fingerprint !== fingerprint)
        pending.current = { fingerprint, key: crypto.randomUUID() }; return pending.current.key; }
    async function create() { const v = await request(`/knowledge-bases/${kb.id}/index-releases`, 'POST', { profile_ref: ref }, { 'Idempotency-Key': key(`create:${ref}`) }); pending.current = null; await load(); await inspect(v.data.id); }
    async function action(name: string) { if (!detail)
        return; const body = { action: name, ...(name === 'verify' ? { probes: JSON.parse(probes) } : {}), ...(['activate', 'rollback'].includes(name) ? { note, quality_reviewed: reviewed } : {}) }; const v = await request(`/index-releases/${detail.id}/actions`, 'POST', body, { 'If-Match': detail.etag, 'Idempotency-Key': key(JSON.stringify([detail.id, body])) }); pending.current = null; setDetail(v.data); setConfirm(null); setNote(''); setReviewed(false); await inspect(detail.id); await load(); }
    useEffect(() => { alive.current = true; void run(async () => { const p = await request(`/knowledge-bases/${kb.id}/index-profiles`); if (alive.current) {
        setProfiles(p.data);
        setRef(p.data[0]?.ref ?? '');
    } await load(); }); return () => { alive.current = false; }; }, []);
    return <Card size="small" title="索引发布与安全重建" extra={<Button disabled={busy} onClick={() => void run(() => load())}>刷新发布计划</Button>}><Space direction="vertical" style={{ width: '100%' }}><Typography.Text type="secondary">先在文档索引详情中发布通过扫描与完整核验的版本，再为已发布资料创建影子重建计划。旧索引持续服务，切换前需完成追赶、完整读回与问题对照。</Typography.Text>{error && <Alert type="error" showIcon message={error}/>}<Space wrap><Select aria-label="目标索引配置" style={{ minWidth: 220 }} value={ref || undefined} onChange={setRef} options={profiles.map(p => ({ value: p.ref, label: `${p.ref} · ${p.model} · ${p.dimension} 维` }))}/><Button disabled={!ref} loading={busy} onClick={() => void run(create)}>创建影子重建计划</Button></Space><List dataSource={rows} locale={{ emptyText: '暂无发布计划' }} renderItem={r => <List.Item actions={[<Button key="detail" onClick={() => { setProbes(''); setNote(''); setReviewed(false); setConfirm(null); void run(() => inspect(r.id)); }}>查看发布计划</Button>]}><Space wrap><Tag>{states[r.status]}</Tag><Typography.Text>{r.profile_ref}</Typography.Text></Space></List.Item>}/>{next && <Button onClick={() => void run(() => load(next))}>加载更多发布计划</Button>}
 <Modal className="release-detail" title="影子索引核验与切换" width={760} open={!!detail} onCancel={() => setDetail(null)} footer={<Button onClick={() => setDetail(null)}>关闭</Button>}>{detail && <Space direction="vertical" style={{ width: '100%' }}>{error && <Alert type="error" showIcon message={error}/>}<Tag>{states[detail.status]}</Tag><Typography.Text>目标配置：{detail.profile_ref} · 文档数：{detail.items?.length ?? 0}</Typography.Text><Button disabled={busy} onClick={() => void run(() => inspect(detail.id))}>刷新计划详情</Button>{['building', 'verified'].includes(detail.status) && <><Space wrap><Button loading={busy} onClick={() => void run(() => action('build'))}>追赶并构建影子索引</Button><Button disabled={busy} onClick={() => void run(() => action('cancel'))}>取消重建计划</Button></Space><Typography.Text>输入脱敏问题及预期文档 ID 的 JSON 数组。对照只使用当前有权读取的完整计划范围，原问题不写入发布记录。</Typography.Text><Input.TextArea aria-label="索引对照问题" value={probes} onChange={e => setProbes(e.target.value)} rows={4} placeholder={'[{"query":"业务问题","expected_document_id":"文档 UUID"}]'}/><Button loading={busy} disabled={!probes.trim()} onClick={() => void run(() => action('verify'))}>完整核验并运行对照</Button></>}{detail.proof?.evaluation && <Alert showIcon type={detail.proof.evaluation.non_regression ? 'success' : 'warning'} message={detail.proof.evaluation.non_regression ? '完整核验与样本对照通过' : '对照存在退化，尚不能切换'} description={`Recall@5：${detail.proof.evaluation.baseline.recall_at_5.toFixed(2)} → ${detail.proof.evaluation.candidate.recall_at_5.toFixed(2)}；MRR：${detail.proof.evaluation.baseline.mrr.toFixed(2)} → ${detail.proof.evaluation.candidate.mrr.toFixed(2)}。样本结果仍需人工核对。`}/>}<List size="small" dataSource={detail.items ?? []} renderItem={i => <List.Item><Typography.Text style={{ overflowWrap: 'anywhere' }}>文档 {i.document_id} · {i.candidate_generation_id ? '候选已核验' : '候选待核验'}{i.error_code ? ` · ${i.error_code}` : ''}</Typography.Text></List.Item>}/>{['verified', 'active'].includes(detail.status) && <><Input.TextArea aria-label="索引发布核对说明" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} placeholder="填写质量、授权范围及切换核对说明（至少10字，仅保存摘要）"/><Checkbox checked={reviewed} onChange={e => setReviewed(e.target.checked)}>已人工核对样本结果、权限范围与回滚条件</Checkbox><Button loading={busy} disabled={!reviewed || note.trim().length < 10} onClick={() => setConfirm(detail.status === 'active' ? 'rollback' : 'activate')}>{detail.status === 'active' ? '准备回滚索引' : '准备切换索引'}</Button>{confirm && <Alert type="warning" message={confirm === 'activate' ? '确认原子切换全部已核验文档的索引？新发布或授权变化会要求重新核验。' : '确认回滚索引？不会恢复旧正文、已删除文档或历史权限。当前内容版本发生变化时会拒绝回滚。'} action={<Button loading={busy} onClick={() => void run(() => action(confirm))}>确认索引操作</Button>}/>}</>}</Space>}</Modal></Space></Card>;
}
