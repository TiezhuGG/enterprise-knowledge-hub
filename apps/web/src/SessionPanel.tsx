import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import type { DataResponse, SessionInfo } from '@zhiheng/contracts';

export function SessionPanel() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [form] = Form.useForm<{ secret: string }>();
  async function refresh() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/auth/session', { signal: AbortSignal.timeout(5000) });
      if (response.status === 401) { setSession(null); return; }
      if (!response.ok) throw new Error('暂时无法验证身份，请检查服务后重试。');
      const result: DataResponse<SessionInfo> = await response.json();
      setSession(result.data);
    } catch { setSession(null); setError('暂时无法验证身份，请检查服务后重试。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!session) return;
    const timeout = setTimeout(() => {
      setSession(null); setError('登录已过期，请重新登录。');
    }, Math.max(0, Date.parse(session.expires_at) - Date.now()));
    return () => clearTimeout(timeout);
  }, [session]);
  async function login({ secret }: { secret: string }) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/auth/dev-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'employee', secret }), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(response.status === 404 ? '开发登录未启用，请联系环境维护者。' : response.status === 429 ? '尝试次数过多，请稍后再试。' : response.status === 401 ? '开发访问口令无效。' : '暂时无法登录，请稍后重试。');
      }
      const result: DataResponse<SessionInfo> = await response.json();
      form.resetFields(); setSession(result.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败，请重试。'); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token }, signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 204) throw new Error();
      setSession(null);
    } catch { setError('退出未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <Card title={session ? '当前身份' : '登录知衡'} style={{ marginBottom: 24 }}>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="开发身份验证" description="此入口仅用于隔离开发环境，企业统一登录尚未接入。" />
      {error && <Alert role="alert" type="error" showIcon message={error} />}
      {session ? <>
        <Typography.Text>已登录：{session.display_name}</Typography.Text>
        <Typography.Text type="secondary">员工 · 当前工作空间已由服务端绑定</Typography.Text>
        <Button loading={busy} onClick={() => void logout()}>退出登录</Button>
      </> : <Form form={form} layout="vertical" onFinish={login} style={{ width: '100%' }}>
        <Form.Item label="开发访问口令" name="secret" rules={[{ required: true, message: '请输入开发访问口令' }]}>
          <Input.Password autoComplete="off" maxLength={1024} placeholder="输入环境维护者配置的访问口令" />
        </Form.Item>
        <Space wrap>
          <Button type="primary" htmlType="submit" loading={busy}>登录</Button>
          <Button disabled={busy} onClick={() => void refresh()}>重新验证</Button>
        </Space>
      </Form>}
    </Space>
  </Card>;
}
