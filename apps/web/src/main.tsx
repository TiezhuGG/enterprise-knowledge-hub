import {AnswerPanel} from './AnswerPanel';
import {SearchPanel} from './SearchPanel';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Button, Card, ConfigProvider, Space, Tag, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { HealthResponse, SessionInfo } from '@zhiheng/contracts';
import './style.css';
import { KnowledgePanel } from './KnowledgePanel';
import { SessionPanel } from './SessionPanel';

function App() {
  const [authEpoch, setAuthEpoch] = useState(0);
  const onExpired = useCallback(() => { setSession(null); setAuthEpoch(value => value + 1); }, []);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 5000);
    setStatus('loading');
    fetch('/api/v1/health/live', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Unavailable');
        const health: HealthResponse = await response.json();
        if (health.service !== 'api' || health.status !== 'ok') throw new Error('Invalid health');
        if (active) setStatus('ok');
      }).catch(() => { if (active) setStatus('error'); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [attempt]);
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#236c5b', borderRadius: 12 } }}>
    <main>
      <header><strong>知衡</strong><span>企业知识中枢</span><Tag>开发环境 · P2-03</Tag></header>
      <section>
        <Typography.Text className="eyebrow">从可信的知识开始</Typography.Text>
        <Typography.Title>让每一次回答，都有据可循。</Typography.Title>
        <Typography.Paragraph>登录当前工作空间，逐步连接可信的知识与带引用的问答。</Typography.Paragraph>
        <SessionPanel key={authEpoch} onChange={setSession} />
        {session && <AnswerPanel key={`answer:${session.identity.actor_id}:${session.identity.tenant_id}:${session.identity.membership_id}:${session.identity.role}`} session={session} onExpired={onExpired}/> }
        {session && <SearchPanel key={`search:${session.identity.actor_id}:${session.identity.tenant_id}:${session.identity.membership_id}:${session.identity.role}`} session={session} onExpired={onExpired}/> }
        {session && <KnowledgePanel key={`${session.identity.actor_id}:${session.identity.tenant_id}:${session.identity.membership_id}:${session.identity.role}`} session={session} onExpired={onExpired} />}
        <Card title="开发服务状态">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert showIcon type={status === 'ok' ? 'success' : status === 'error' ? 'error' : 'info'}
              message={status === 'ok' ? 'API 进程已连接' : status === 'error' ? '暂时无法连接 API，请检查服务后重试' : '正在连接 API…'} />
            <Typography.Text type="secondary">此检查只确认 API 存活；数据库、队列、检索与模型状态尚未接入。</Typography.Text>
            <Button onClick={() => setAttempt(value => value + 1)} loading={status === 'loading'}>重新检查</Button>
          </Space>
        </Card>
        <p className="note">当前支持文档解析、分块与向量索引接入；已接入授权检索、带运行状态与历史的原文摘录问答；真实模型质量验收待本地模型服务就绪。</p>
      </section>
    </main>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
