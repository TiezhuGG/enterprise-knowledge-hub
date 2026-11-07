import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Empty, Form, Input, List, Modal, Select, Space, Tag, Typography } from 'antd';
import { RESOURCE_ACTIONS, type KnowledgeBase, type ResourceGrant, type ResourcePage, type SessionInfo } from '@zhiheng/contracts';

const labels = { read: '阅读', download: '下载', write: '上传与编辑', publish: '发布', delete: '删除文档', manage: '管理配置', manage_acl: '管理权限' };
const errorText = (status: number) => status === 401 ? '登录已失效，请重新登录。' : status === 404 ? '内容不可用或无权访问。' : status === 412 ? '配置已被其他人修改，请关闭并重新打开后再操作。' : status === 409 ? '变更存在冲突，请保留至少一位有效管理者，并检查创建请求是否重复。' : status === 400 ? '请检查名称、成员或组标识以及权限配置。' : status === 403 ? '当前身份不允许执行此操作。' : '服务暂时不可用，请稍后重试。';
export function KnowledgePanel({ session, onExpired }: { session: SessionInfo; onExpired: () => void }) {
  const [rows, setRows] = useState<KnowledgeBase[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState(''); const [status, setStatus] = useState('active');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<{ resource: KnowledgeBase; etag: string } | null>(null);
  const [acl, setAcl] = useState<{ id: string; etag: string; grants: ResourceGrant[] } | null>(null);
  const creation = useRef<{ body: string; key: string } | null>(null);
  const [createForm] = Form.useForm(); const [editForm] = Form.useForm();
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`/api/v1${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, ...init.headers } });
    if (!response.ok) { if (response.status === 401) onExpired(); throw new Error(errorText(response.status)); }
    return response;
  }
  async function load(cursor?: string, append = false) {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ limit: '20', q, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
      const response = await request(`/knowledge-bases?${query}`);
      const page: ResourcePage<KnowledgeBase> = await response.json();
      setRows(old => append ? [...old, ...page.data] : page.data); setNext(page.page.next_cursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败，请重试。'); setRows([]); setNext(null); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true; const controller = new AbortController(); setRows([]); setNext(null); setError(''); setBusy(true);
    const query = new URLSearchParams({ limit: '20', q, ...(status ? { status } : {}) });
    fetch(`/api/v1/knowledge-bases?${query}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) { if (response.status === 401 && active) onExpired(); throw new Error(errorText(response.status)); }
      const page: ResourcePage<KnowledgeBase> = await response.json();
      if (active) { setRows(page.data); setNext(page.page.next_cursor); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '加载失败，请重试。'); }).finally(() => { if (active) setBusy(false); });
    const timeout = setTimeout(() => controller.abort(), 8000);
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [q, status, session.identity.actor_id, onExpired]);
  async function create(values: { name: string; description?: string }) {
    setBusy(true); setError('');
    try {
      const body = JSON.stringify({ name: values.name.trim(), description: values.description?.trim() ?? '', publish_policy: 'manual' });
      if (creation.current?.body !== body) creation.current = { body, key: crypto.randomUUID() };
      await request('/knowledge-bases', { method: 'POST', body, headers: { 'Idempotency-Key': creation.current!.key } });
      creation.current = null; createForm.resetFields(); setCreateOpen(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败，请重试。'); }
    finally { setBusy(false); }
  }
  async function open(row: KnowledgeBase) {
    setBusy(true); setError('');
    try {
      const response = await request(`/knowledge-bases/${row.id}`); const { data } = await response.json();
      setSelected({ resource: data, etag: response.headers.get('etag')! });
    } catch (cause) { await load(); setError(cause instanceof Error ? cause.message : '打开失败。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (selected) editForm.setFieldsValue(selected.resource); }, [selected, editForm]);
  async function save(values: { name: string; description: string; status: string }) {
    if (!selected) return; setBusy(true); setError('');
    try {
      await request(`/knowledge-bases/${selected.resource.id}`, { method: 'PATCH', body: JSON.stringify(values), headers: { 'If-Match': selected.etag } });
      setSelected(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  async function openAcl(row: KnowledgeBase) {
    setBusy(true); setError('');
    try { const response = await request(`/knowledge-bases/${row.id}/acl`); const { data } = await response.json(); setAcl({ id: row.id, etag: response.headers.get('etag')!, grants: data.grants }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '权限加载失败。'); }
    finally { setBusy(false); }
  }
  async function saveAcl() {
    if (!acl) return; setBusy(true); setError('');
    try { await request(`/knowledge-bases/${acl.id}/acl`, { method: 'PUT', body: JSON.stringify({ grants: acl.grants }), headers: { 'If-Match': acl.etag } }); setAcl(null); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '权限保存失败。'); }
    finally { setBusy(false); }
  }
  function changeGrant(index: number, patch: Partial<ResourceGrant>) { setAcl(old => old && ({ ...old, grants: old.grants.map((grant, i) => i === index ? { ...grant, ...patch } : grant) })); }
  const notice = error && <Alert role="alert" showIcon type="error" message={error} style={{ marginBottom: 16 }} />;
  return <Card title="知识库" style={{ marginBottom: 24 }} extra={session.identity.capabilities.includes('knowledge:create') && <Button type="primary" onClick={() => { setError(''); setCreateOpen(true); }}>新建知识库</Button>}>
    {notice}
    <Space wrap style={{ marginBottom: 16 }}>
      <Input.Search aria-label="搜索知识库" placeholder="搜索可见知识库" allowClear onSearch={setQ} style={{ width: 220 }} />
      <Select aria-label="知识库状态" value={status} onChange={setStatus} style={{ width: 110 }} options={[{ value: 'active', label: '使用中' }, { value: 'archived', label: '已归档' }, { value: '', label: '全部状态' }]} />
      <Button disabled={busy} onClick={() => void load()}>刷新列表</Button>
    </Space>
    <List className="knowledge-list" loading={busy} dataSource={rows} locale={{ emptyText: <Empty description="暂无可见知识库，或当前身份尚未获授权" /> }} renderItem={row => <List.Item actions={[
      <Button key="open" onClick={() => void open(row)}>查看</Button>,
      ...(row.capabilities.includes('manage_acl') ? [<Button key="acl" onClick={() => void openAcl(row)}>管理权限</Button>] : []),
    ]}>
      <List.Item.Meta title={<Space wrap>{row.name}<Tag>{row.status === 'active' ? '使用中' : '已归档'}</Tag></Space>} description={row.description || '暂无描述'} />
    </List.Item>} />
    {next && <Button disabled={busy} onClick={() => void load(next, true)}>加载更多</Button>}
    <Typography.Paragraph type="secondary">新建知识库默认私有。这里只显示当前身份获授权的资源。</Typography.Paragraph>
    <Modal title="新建知识库" open={createOpen} footer={null} onCancel={() => setCreateOpen(false)} destroyOnHidden>
      {notice}<Form form={createForm} layout="vertical" onFinish={create}>
        <Form.Item name="name" label="知识库名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="description" label="描述"><Input.TextArea maxLength={2000} /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>创建私有知识库</Button>
      </Form>
    </Modal>
    <Modal title="知识库详情" open={!!selected} footer={null} onCancel={() => setSelected(null)} destroyOnHidden>
      {notice}<Form form={editForm} layout="vertical" onFinish={save} disabled={!selected?.resource.capabilities.includes('manage')}>
        <Form.Item name="name" label="知识库名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="description" label="描述"><Input.TextArea maxLength={2000} /></Form.Item>
        <Form.Item name="status" label="状态"><Select options={[{ value: 'active', label: '使用中' }, { value: 'archived', label: '已归档' }]} /></Form.Item>
        {selected?.resource.capabilities.includes('manage') && <Button type="primary" htmlType="submit" loading={busy}>保存配置</Button>}
      </Form>
    </Modal>
    <Modal title="知识库权限" open={!!acl} onCancel={() => setAcl(null)} onOk={() => void saveAcl()} okText="保存权限" confirmLoading={busy} destroyOnHidden>
      {notice}<Typography.Paragraph>按成员或组的稳定标识授权。角色会进一步限制可执行操作；至少保留一位有效管理者。</Typography.Paragraph>
      {acl?.grants.map((grant, index) => <Card key={index} size="small" style={{ marginBottom: 12 }}>
        <Space wrap style={{ marginBottom: 8 }}>
          <Select aria-label={`授权类型 ${index + 1}`} value={grant.principal_type} onChange={value => changeGrant(index, { principal_type: value })} options={[{ value: 'member', label: '成员' }, { value: 'group', label: '组' }]} />
          <Input aria-label={`授权标识 ${index + 1}`} placeholder="稳定成员或组标识" value={grant.principal_id} onChange={event => changeGrant(index, { principal_id: event.target.value })} />
          <Button danger onClick={() => setAcl(old => old && ({ ...old, grants: old.grants.filter((_, i) => i !== index) }))}>移除</Button>
        </Space>
        <Checkbox.Group options={RESOURCE_ACTIONS.map(value => ({ value, label: labels[value] }))} value={grant.actions} onChange={value => changeGrant(index, { actions: value })} />
      </Card>)}
      <Button disabled={(acl?.grants.length ?? 0) >= 100} onClick={() => setAcl(old => old && ({ ...old, grants: [...old.grants, { principal_type: 'member', principal_id: '', actions: ['read'] }] }))}>添加授权</Button>
    </Modal>
  </Card>;
}
