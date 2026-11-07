import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, List, Modal, Space, Tag, Typography } from 'antd';
import type { KnowledgeBase, SessionInfo } from '@zhiheng/contracts';
type Cleanup = {
    id: string;
    document_id: string;
    status: string;
    stage: string;
    error_code: string | null;
    not_before: string;
    attempt_count: number;
    items?: Array<{
        kind: string;
        status: string;
        count: number;
    }>;
    events?: Array<{
        kind: string;
        error_code: string | null;
        created_at: string;
    }>;
};
const states: Record<string, string> = { pending: '等待保留期或清理服务', running: '正在清理', retry_wait: '等待自动重试', waiting_dependency: '需要核对依赖', failed: '清理失败', succeeded: '已完成物理清理' };
const stages: Record<string, string> = { retention: '等待保留期', writers: '核对写入结果', vectors: '清理向量索引', objects: '清理文件', metadata: '清理结构和历史正文', finished: '完成' };
const kinds: Record<string, string> = { object: '对象文件', vector: '向量索引', pg: '派生数据与历史正文' };
const events: Record<string, string> = { deleted: '删除已生效', started: '开始清理', succeeded: '清理完成', failed: '清理失败', blocked: '依赖待核对', retry: '维护者重试', reconcile_writes: '维护者确认写入收敛', bind_legacy: '维护者确认旧存储' };
const errors: Record<string, string> = { WRITES_REQUIRE_RECONCILIATION: '仍有写入正在进行或结果不明。请先停止旧处理进程、核对远端结果，再确认写入已收敛。', WRITER_DRAIN_REQUIRED: '写入记录至少需要静置五分钟；请先核对并停止旧进程。', OBJECT_STORAGE_BINDING_REQUIRED: '对象存储配置尚未核对。请确认当前桶和地址确实属于原文档，旧记录可通过核对旧存储操作补齐绑定。', VECTOR_STORAGE_BINDING_REQUIRED: '向量存储配置尚未核对。旧记录需要确认所属存储，已有绑定必须使用原配置。', OBJECT_INVENTORY_REQUIRED: '对象存储未提供完整版本清单，无法确认清理完成。', CLEANUP_ACTION_UNAVAILABLE: '清理状态已变化，请刷新记录。' };
export function CleanupsPanel({ kb, session, onExpired }: {
    kb: KnowledgeBase;
    session: SessionInfo;
    onExpired: () => void;
}) {
    const [rows, setRows] = useState<Cleanup[]>([]), [next, setNext] = useState<string | null>(null), [detail, setDetail] = useState<Cleanup | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [action, setAction] = useState<string | null>(null), [note, setNote] = useState('');
    const alive = useRef(true);
    async function request(path: string, method = 'GET', body?: object) { const r = await fetch(`/api/v1${path}`, { method, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token }, ...(body ? { body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) {
        if (r.status === 401)
            onExpired();
        throw new Error(errors[v.error?.code] ?? (r.status === 404 ? '清理记录不可用或权限已变化。' : '操作失败，请刷新后重试。'));
    } return v; }
    async function load(cursor?: string) { try {
        setError('');
        const v = await request(`/knowledge-bases/${kb.id}/cleanups?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (alive.current) {
            setRows(old => cursor ? [...old, ...v.data] : v.data);
            setNext(v.page.next_cursor);
        }
    }
    catch (e) {
        setError((e as Error).message);
    } }
    async function inspect(id: string) { try {
        setError('');
        const v = await request(`/cleanups/${id}`);
        if (alive.current)
            setDetail(v.data);
    }
    catch (e) {
        setDetail(null);
        setError((e as Error).message);
    } }
    async function execute() { if (!detail || !action)
        return; setBusy(true); try {
        await request(`/cleanups/${detail.id}/actions`, 'POST', { action, note });
        setAction(null);
        setNote('');
        await inspect(detail.id);
        await load();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    useEffect(() => { void load(); return () => { alive.current = false; }; }, []);
    return <Card size="small" title="删除与清理记录" extra={<Button onClick={() => void load()}>刷新清理记录</Button>}><Space direction="vertical" style={{ width: '100%' }}>
  <Typography.Text type="secondary">删除后访问立即失效。物理清理按保留期异步进行；“已完成”以存储确认和数据库清理记录为准。</Typography.Text>{error && <Alert type="error" showIcon message={error}/>}
  <List dataSource={rows} locale={{ emptyText: '暂无删除记录' }} renderItem={r => <List.Item actions={[<Button key="detail" onClick={() => void inspect(r.id)}>查看清理记录</Button>]}><List.Item.Meta title={<Tag>{states[r.status] ?? r.status}</Tag>} description={`文档 ${r.document_id} · 最早清理 ${new Date(r.not_before).toLocaleString()}`}/></List.Item>}/>{next && <Button onClick={() => void load(next)}>加载更多清理记录</Button>}
  <Modal title="清理进度与处理记录" open={!!detail} onCancel={() => { setDetail(null); setAction(null); }} footer={<Button onClick={() => setDetail(null)}>关闭</Button>}>
   {detail && <Space direction="vertical" style={{ width: '100%' }}><Tag>{states[detail.status]}</Tag><Typography.Text>阶段：{stages[detail.stage] ?? '处理中'} · 本轮尝试 {detail.attempt_count} 次</Typography.Text>{detail.error_code && <Alert type="warning" message={errors[detail.error_code] ?? `清理暂未完成（${detail.error_code}），请核对存储服务后重试。`}/>}<Button onClick={() => void inspect(detail.id)}>刷新进度</Button>{detail.items?.map(i => <Typography.Text key={i.kind + i.status}>{kinds[i.kind] ?? '清理项目'} · {i.status === 'done' ? '已确认' : '待确认'}：{i.count}</Typography.Text>)}
    {kb.capabilities.includes('manage') && !['running', 'succeeded'].includes(detail.status) && <Space wrap>{['retry', 'reconcile_writes', 'bind_legacy'].map(a => <Button key={a} onClick={() => { setAction(a); setNote(''); }}>{a === 'retry' ? '重试清理' : a === 'reconcile_writes' ? '确认写入已收敛' : '确认旧存储'}</Button>)}</Space>}
    {action && <><Alert type="warning" message={action === 'reconcile_writes' ? '确认前必须停止旧写入进程并核对远端未决请求；静置时间不能代替核对。' : action === 'bind_legacy' ? '仅在已确认旧对象和索引属于当前配置的存储后提交。不会覆盖已有绑定。' : '重试保持原保留期，并从已有清理记录继续。'}/><Input.TextArea aria-label="清理操作核对说明" value={note} maxLength={2000} onChange={e => setNote(e.target.value)} placeholder="填写核对说明（至少 10 字）"/><Button loading={busy} disabled={note.trim().length < 10} onClick={() => void execute()}>提交清理操作</Button></>}
    <List size="small" dataSource={detail.events ?? []} renderItem={e => <List.Item>{new Date(e.created_at).toLocaleString()} · {events[e.kind] ?? '处理记录'}{e.error_code ? ` · ${e.error_code}` : ''}</List.Item>}/>
   </Space>}
  </Modal>
 </Space></Card>;
}
