import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, List, Modal, Space, Tag, Typography } from 'antd';
import type { KnowledgeBase, SessionInfo } from '@zhiheng/contracts';
type Connector = {
    id: string;
    config_ref: string;
    status: string;
    cursor: number;
    observed_end: number;
    row_version: number;
    runs?: Array<{
        id: string;
        mode: string;
        status: string;
        attempts: number;
        applied: number;
        error_code: string | null;
    }>;
    items?: Array<{
        state: string;
        count: number;
    }>;
};
const states: Record<string, string> = { active: '同步有效', blocked: '读取已关闭，等待同步核验', paused: '已暂停', removed: '已移除', queued: '等待处理', running: '同步中', retry_wait: '等待重试', succeeded: '同步完成', failed: '同步失败', cancelled: '已取消', importing: '待导入', revoked: '源端已撤权', quarantined: '权限待映射', deleted: '已删除' };
export function ConnectorsPanel({ kb, session, onExpired }: {
    kb: KnowledgeBase;
    session: SessionInfo;
    onExpired: () => void;
}) {
    const [documents, setDocuments] = useState<Array<{
        id: string;
        status: string;
        state: string;
        etag: string;
    }>>([]), [documentNext, setDocumentNext] = useState<string | null>(null), [deleting, setDeleting] = useState<{
        id: string;
        etag: string;
        key: string;
    } | null>(null);
    const [rows, setRows] = useState<Connector[]>([]), [next, setNext] = useState<string | null>(null), [detail, setDetail] = useState<Connector | null>(null), [ref, setRef] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState<string | null>(null);
    const alive = useRef(true), attempt = useRef<{
        ref: string;
        key: string;
    } | null>(null);
    async function request(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}) { const r = await fetch(`/api/v1${path}`, { method, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) {
        if (r.status === 401)
            onExpired();
        throw new Error(r.status === 412 ? '连接器状态已变化，请刷新后操作。' : r.status === 404 ? '记录不可用或无权管理。' : v.error?.code === 'SOURCE_NOT_CONFIGURED' ? '该别名尚未绑定此资料库，请由维护者配置受控目录。' : v.error?.code === 'SYNC_ALREADY_RUNNING' ? '已有同步正在进行，请刷新进度。' : '操作暂未完成，请核对配置并刷新重试。');
    } return v; }
    async function load(cursor?: string) { const v = await request(`/knowledge-bases/${kb.id}/connectors?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setRows(old => cursor ? [...old, ...v.data] : v.data);
        setNext(v.page.next_cursor);
    } }
    async function inspect(id: string) { const v = await request(`/connectors/${id}`); if (alive.current)
        setDetail(v.data); await loadDocuments(id); }
    async function loadDocuments(id: string, cursor?: string) { const v = await request(`/connectors/${id}/documents?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (alive.current) {
        setDocuments(old => cursor ? [...old, ...v.data] : v.data);
        setDocumentNext(v.page.next_cursor);
    } }
    async function deleteImported() { if (!deleting || !detail)
        return; await request(`/documents/${deleting.id}`, 'DELETE', undefined, { 'If-Match': deleting.etag, 'Idempotency-Key': deleting.key }); setDeleting(null); await inspect(detail.id); }
    async function perform(fn: () => Promise<void>) { setBusy(true); setError(''); try {
        await fn();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function create() { if (!attempt.current || attempt.current.ref !== ref)
        attempt.current = { ref, key: crypto.randomUUID() }; await request(`/knowledge-bases/${kb.id}/connectors`, 'POST', { config_ref: ref }, { 'Idempotency-Key': attempt.current.key }); attempt.current = null; setRef(''); await load(); }
    async function sync(mode: string) { if (!detail)
        return; await request(`/connectors/${detail.id}/sync`, 'POST', { mode }, { 'Idempotency-Key': crypto.randomUUID() }); await inspect(detail.id); await load(); }
    async function action() { if (!detail || !confirm)
        return; await request(`/connectors/${detail.id}/actions`, 'POST', { action: confirm }, { 'If-Match': `"connector:${detail.id}:${detail.row_version}"` }); setConfirm(null); await inspect(detail.id); await load(); }
    useEffect(() => { void perform(() => load()); return () => { alive.current = false; }; }, []);
    return <Card className="connectors-panel" title="本地目录连接器" size="small" extra={<Button onClick={() => void perform(() => load())}>刷新连接器</Button>}><Space direction="vertical" style={{ width: '100%' }}><Typography.Text type="secondary">使用维护者配置的目录别名。源端授权与本地权限共同决定读取范围；导入后仍需扫描、索引和发布。暂停或移除会立即关闭源文档读取，保留已导入资料。</Typography.Text>{error && <Alert showIcon type="error" message={error}/>}<Space wrap><Input aria-label="受控目录配置别名" placeholder="已配置的目录别名" maxLength={64} value={ref} onChange={e => setRef(e.target.value)}/><Button disabled={!/^[a-zA-Z0-9_-]{1,64}$/.test(ref)} loading={busy} onClick={() => void perform(create)}>添加连接器</Button></Space><List dataSource={rows} locale={{ emptyText: '暂无连接器' }} renderItem={r => <List.Item actions={[<Button key="detail" onClick={() => void perform(() => inspect(r.id))}>查看同步记录</Button>]}><List.Item.Meta title={r.config_ref} description={<><Tag>{states[r.status]}</Tag>已提交检查点 {r.cursor} / 已观察事件 {r.observed_end}</>}/></List.Item>}/>{next && <Button onClick={() => void perform(() => load(next))}>加载更多连接器</Button>}
 <Modal className="connector-detail" title="目录同步与权限状态" open={!!detail} onCancel={() => { setDetail(null); setConfirm(null); setDeleting(null); }} footer={<Button onClick={() => setDetail(null)}>关闭</Button>}>{detail && <Space direction="vertical" style={{ width: '100%' }}><Tag>{states[detail.status]}</Tag><Typography.Text>检查点：{detail.cursor} / {detail.observed_end}</Typography.Text><Button onClick={() => void perform(() => inspect(detail.id))}>刷新同步进度</Button>{!['paused', 'removed'].includes(detail.status) && <Space wrap><Button loading={busy} onClick={() => void perform(() => sync('incremental'))}>增量同步</Button><Button loading={busy} onClick={() => void perform(() => sync('full'))}>完整校验并同步</Button></Space>}{detail.status !== 'removed' && <Space wrap><Button onClick={() => setConfirm(detail.status === 'paused' ? 'resume' : 'pause')}>{detail.status === 'paused' ? '恢复连接器' : '暂停连接器'}</Button><Button danger onClick={() => setConfirm('remove')}>移除连接器</Button></Space>}{confirm && <Alert type="warning" message={confirm === 'resume' ? '恢复后请发起同步，核验通过才恢复读取。' : '此操作会关闭源文档读取，已导入文档仍会保留。'} action={<Button loading={busy} onClick={() => void perform(action)}>确认操作</Button>}/>}<List size="small" dataSource={documents} locale={{ emptyText: '暂无导入文档' }} renderItem={d => <List.Item actions={d.status === 'deleted' ? [] : [<Button danger key="delete" onClick={() => setDeleting({ id: d.id, etag: d.etag, key: crypto.randomUUID() })}>删除导入文档</Button>]}><Typography.Text>文档 {d.id} · {d.status === 'deleted' ? '已删除' : states[d.state]}</Typography.Text></List.Item>}/>{documentNext && <Button onClick={() => void perform(() => loadDocuments(detail.id, documentNext))}>加载更多导入文档</Button>}{deleting && <Alert type="warning" message="确认删除该导入文档？访问会立即失效，并按保留期清理；同一来源标识不会再次导入。" action={<Button danger loading={busy} onClick={() => void perform(deleteImported)}>确认删除文档</Button>}/>}<Typography.Text type="secondary">完整校验验证全部事件历史；目录缺页或文件缺失不会被视为删除。资料清理通过文档删除流程执行。</Typography.Text>{detail.items?.map(i => <Typography.Text key={i.state}>{states[i.state]}：{i.count}</Typography.Text>)}<List dataSource={detail.runs ?? []} locale={{ emptyText: '暂无同步任务' }} renderItem={r => <List.Item><Space direction="vertical"><Typography.Text>{r.mode === 'full' ? '完整校验' : '增量同步'} · {states[r.status]} · 已提交 {r.applied} 项 · 尝试 {r.attempts} 次</Typography.Text>{r.error_code && <Typography.Text type="warning">{r.error_code}</Typography.Text>}</Space></List.Item>}/></Space>}</Modal></Space></Card>;
}
