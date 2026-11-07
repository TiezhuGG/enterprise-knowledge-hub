import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Button, Card, ConfigProvider, Space, Tag, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { HealthResponse } from '@zhiheng/contracts';
import './style.css';
import { SessionPanel } from './SessionPanel';

function App() {
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
      <header><strong>知衡</strong><span>企业知识中枢</span><Tag>开发环境 · P1-02</Tag></header>
      <section>
        <Typography.Text className="eyebrow">从可信的知识开始</Typography.Text>
        <Typography.Title>让每一次回答，都有据可循。</Typography.Title>
        <Typography.Paragraph>登录当前工作空间，逐步连接可信的知识与带引用的问答。</Typography.Paragraph>
        <SessionPanel />
        <Card title="开发服务状态">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert showIcon type={status === 'ok' ? 'success' : status === 'error' ? 'error' : 'info'}
              message={status === 'ok' ? 'API 进程已连接' : status === 'error' ? '暂时无法连接 API，请检查服务后重试' : '正在连接 API…'} />
            <Typography.Text type="secondary">此检查只确认 API 存活；数据库、队列、检索与模型状态尚未接入。</Typography.Text>
            <Button onClick={() => setAttempt(value => value + 1)} loading={status === 'loading'}>重新检查</Button>
          </Space>
        </Card>
        <p className="note">当前支持开发身份登录。知识库、上传与问答功能将在后续任务实现。</p>
      </section>
    </main>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
