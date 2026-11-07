import {CorrectionsPanel} from './CorrectionsPanel';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import type { ChatRun, Conversation, ResourcePage, SearchEvidence, SessionInfo, ChatEvent } from '@zhiheng/contracts';
import { applyChatEvent, liveChat, stageLabel, type LiveChat } from './chat-events';
const terminal = (r: ChatRun) => r.status !== 'running';
export function AnswerPanel({ session, onExpired }: {
    session: SessionInfo;
    onExpired: () => void;
}) {
    const scope = `zhiheng.chat:${session.identity.tenant_id}:${session.identity.membership_id}`;
    const [correctionSource,setCorrectionSource]=useState<SearchEvidence|null>(null);
    const [question, setQuestion] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conversations, setConversations] = useState<Conversation[]>([]), [selected, setSelected] = useState(''), [runs, setRuns] = useState<ChatRun[]>([]), [live, setLive] = useState<LiveChat | null>(null), [connection, setConnection] = useState(''), [source, setSource] = useState<{
        evidence: SearchEvidence;
        quote: string;
    } | null>(null), [more, setMore] = useState<string | null>(null), [older, setOlder] = useState<string | null>(null);
    const stream = useRef<EventSource | null>(null), epoch = useRef(0), selectedRef = useRef(''), liveRef = useRef<LiveChat | null>(null), sourcePanel = useRef<HTMLDivElement | null>(null), sourceRequest = useRef(0), regeneration = useRef(new Map<string, string>()), submission = useRef<{
        key: string;
        conversation: string;
        question: string;
    } | null>(null);
    const remember = (id: string) => { try {
        sessionStorage.setItem(scope, id);
    }
    catch { } };
    async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) { const r = await fetch(`/api/v1${path}`, { method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) }); if (!r.ok) {
        if (r.status === 401) {
            onExpired();
            throw new Error('登录已失效，请重新登录。');
        }
        const e = await r.json().catch(() => ({}));
        throw new Error(r.status === 409 ? '当前会话仍有运行中的请求，或提交信息已变化，请恢复会话。' : r.status === 429 ? '请求或连接过多，请等待后重试。' : r.status === 404 ? '会话或来源不可用，请刷新。' : `请求未完成（${e.error?.code ?? r.status}）。`);
    } return r.json(); }
    function stopStream() { stream.current?.close(); stream.current = null; liveRef.current = null; setLive(null); }
    async function list(cursor?: string) { const p: ResourcePage<Conversation> = await request(`/conversations?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); setConversations(old => cursor ? [...new Map([...old,...p.data].map(c=>[c.id,c])).values()] : p.data); setMore(p.page.next_cursor); }
    async function loadMessages(id: string, version: number, cursor?: string, watch=true) { const p: ResourcePage<ChatRun> = await request(`/conversations/${id}/messages?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (epoch.current !== version || selectedRef.current !== id)
        return; setRuns(old => cursor ? [...new Map([...old,...p.data].map(r=>[r.id,r])).values()] : p.data); setOlder(p.page.next_cursor); const active = p.data.find(r => !terminal(r)); if (!cursor && active && watch)
        observe(active, version);
    else if (!cursor) {
        stopStream();
        setConnection('');
    } }
    async function select(id: string) { const version = ++epoch.current; stopStream(); selectedRef.current = id; setSelected(id); setRuns([]); setSource(null); setError(''); setOlder(null); submission.current = null; remember(id); if (id)
        try {
            await loadMessages(id, version);
        }
        catch (e) {
            if (epoch.current === version)
                setError((e as Error).message);
        } }
    function observe(run: ChatRun, version: number) {
        stream.current?.close();
        const state = liveChat(run);
        liveRef.current = state;
        setLive(state);
        setConnection('正在连接运行事件');
        const events = new EventSource(`${run.events_url}?after=${state.seq}`);
        stream.current = events;
        const valid = () => epoch.current === version && stream.current === events;
        async function recover() { if (!valid())
            return; try {
            const r: ChatRun = (await request(`/chat-runs/${run.id}`)).data;
            if (!valid())
                return;
            if (terminal(r)) {
                events.close();
                await loadMessages(r.conversation_id, version);
            }
            else
                setConnection('连接中断，正在恢复同一次运行');
        }
        catch (e) {
            if (valid()) {
                setError((e as Error).message);
                setConnection('连接中断，可恢复会话状态');
            }
        } }
        events.onopen = () => { if (valid())
            setConnection('已连接，同一次运行持续进行'); };
        events.onerror = () => { void recover(); };
        for (const type of ['run.started', 'run.progress', 'citation.upsert', 'answer.delta', 'run.completed', 'run.failed', 'run.cancelled'])
            events.addEventListener(type, event => { if (!valid())
                return; try {
                const next = applyChatEvent(liveRef.current!, JSON.parse((event as MessageEvent).data) as ChatEvent);
                liveRef.current = next;
                setLive(next);
                if (next.terminal) {
                    events.close();
                    void loadMessages(run.conversation_id, version).catch(e => setError(e.message));
                }
            }
            catch {
                events.close();
                void request(`/chat-runs/${run.id}`).then(p => { if (valid())
                    return loadMessages(p.data.conversation_id, version); }).catch(e => { if (valid())
                    setError(e.message); });
            } });
        for (const type of ['stream.auth_required', 'stream.access_revoked', 'stream.reset_required', 'stream.unavailable'])
            events.addEventListener(type, () => { if (!valid())
                return; events.close(); setSource(null); setRuns([]); setLive(null); liveRef.current = null; if (type === 'stream.auth_required') {
                onExpired();
                return;
            } setConnection(type === 'stream.access_revoked' ? '依据的访问权限已变化，回答已隐藏。' : '事件连接需要恢复，正在读取当前状态。'); void loadMessages(run.conversation_id, version,undefined,type!=='stream.unavailable').then(()=>{if(type==='stream.unavailable'&&epoch.current===version)setConnection('事件连接暂不可用；后台状态已恢复，可点击恢复会话状态重新连接。')}).catch(e => setError(e.message)); });
    }
    useEffect(() => { let active = true; void list().then(async () => { let id = ''; try {
        id = sessionStorage.getItem(scope) ?? '';
    }
    catch { } if (active && id)
        await select(id); }).catch(e => { if (active)
        setError(e.message); }); return () => { active = false; epoch.current++; stream.current?.close(); }; }, []);
    async function send() {
        sourceRequest.current++;
        if (!question.trim() || busy)
            return;
        setBusy(true);
        setError('');
        setSource(null);
        const version = epoch.current;
        try {
            let conversation = selectedRef.current;
            if (!conversation) {
                let key = '';
                try {
                    key = sessionStorage.getItem(`${scope}:create`) ?? '';
                }
                catch { }
                if (!key) {
                    key = crypto.randomUUID();
                    try {
                        sessionStorage.setItem(`${scope}:create`, key);
                    }
                    catch { }
                }
                const c: Conversation = (await request('/conversations', 'POST', { title: '问答会话' }, { 'Idempotency-Key': key })).data;
                try {
                    sessionStorage.removeItem(`${scope}:create`);
                }
                catch { }
                if (epoch.current !== version)
                    return;
                conversation = c.id;
                selectedRef.current = c.id;
                setSelected(c.id);
                remember(c.id);
                await list();
            }
            const previous = submission.current;
            if (!previous)
                submission.current = { key: crypto.randomUUID(), conversation, question: question.trim() };
            const pending = submission.current!;
            const run: ChatRun = (await request('/chat-runs', 'POST', { conversation_id: pending.conversation, message: pending.question }, { 'Idempotency-Key': pending.key })).data;
            if (epoch.current !== version)
                return;
            submission.current = null;
            setQuestion('');
            setRuns(old => [run, ...old.filter(r => r.id !== run.id)]);
            observe(run, version);
        }
        catch (e) {
            if (epoch.current === version)
                setError(`${(e as Error).message} 提交状态可能尚未确认；可恢复会话，或再次提交同一次请求。`);
        }
        finally {
            setBusy(false);
        }
    }
    async function cancel(run: ChatRun) { setBusy(true); setError(''); try {
        await request(`/chat-runs/${run.id}/cancel`, 'POST', {});
        await loadMessages(run.conversation_id, epoch.current);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    async function regenerate(run: ChatRun) { sourceRequest.current++;setSource(null);const version = epoch.current; setBusy(true); setError(''); const key = regeneration.current.get(run.id) ?? crypto.randomUUID(); regeneration.current.set(run.id, key); try {
        const r: ChatRun = (await request(`/chat-runs/${run.id}/regenerate`, 'POST', {}, { 'Idempotency-Key': key })).data;
        regeneration.current.delete(run.id);
        if (version !== epoch.current || selectedRef.current !== run.conversation_id)
            return;
        setRuns(old => [r, ...old.filter(oldRun => oldRun.id !== r.id)]);
        observe(r, epoch.current);
    }
    catch (e) {
        if (version === epoch.current) {
            setError((e as Error).message);
            await loadMessages(run.conversation_id, version).catch(() => { });
        }
    }
    finally {
        setBusy(false);
    } }
    async function vote(run: ChatRun, value: 'helpful' | 'unhelpful') { try {
        await request(`/chat-runs/${run.id}/feedback`, 'POST', { value });
        setRuns(old => old.map(r => r.id === run.id ? { ...r, feedback: value } : r));
    }
    catch (e) {
        setError((e as Error).message);
    } }
    async function verify(run: ChatRun, evidence: SearchEvidence, quote: string) { const sourceVersion=++sourceRequest.current;setSource(null); setError(''); const version = epoch.current; try {
        const fresh: SearchEvidence = (await request(`/citations/${encodeURIComponent(evidence.citation_id)}`)).data;
        if (version !== epoch.current || sourceVersion!==sourceRequest.current)
            return;
        setSource({ evidence: fresh, quote });
        requestAnimationFrame(() => { sourcePanel.current?.focus(); sourcePanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    }
    catch (e) {
        if (version !== epoch.current || sourceVersion!==sourceRequest.current)
            return;
        setRuns([]);
        stopStream();
        setError((e as Error).message);
        await loadMessages(run.conversation_id, version).catch(() => { });
    } }
    const active = runs.find(r => r.status === 'running'), display = [...runs].reverse();
    return <Card title="带引用的流式问答"><Space direction="vertical" size="middle" style={{ width: '100%' }}><Typography.Text type="secondary">先核验原文与权限，再输出摘录。每条问题独立检索，请在追问中写明主题。切换会话不会停止后台请求。</Typography.Text>
 <Space wrap><Select aria-label="问答历史会话" style={{ width: 240, maxWidth: '100%' }} value={selected || undefined} placeholder="选择历史会话" onChange={id => void select(id)} options={conversations.map(c => ({ value: c.id, label: `${c.title} · ${new Date(c.created_at).toLocaleString()}` }))}/><Button disabled={busy} onClick={() => void select('')}>新建会话</Button><Button disabled={busy} onClick={() => { const version=++epoch.current;setRuns([]); setSource(null); stopStream(); if (selected)
        void loadMessages(selected, version).catch(e => setError(e.message)); void list().catch(e => setError(e.message)); }}>恢复会话状态</Button>{more && <Button onClick={() => void list(more)}>加载更多会话</Button>}{selected && <Button disabled={busy || !!active} danger onClick={() => { void request(`/conversations/${selected}`, 'DELETE').then(async () => { await select(''); await list(); }).catch(e => setError(e.message)); }}>删除当前会话</Button>}</Space>
 {error && <Alert role="alert" type="error" showIcon message={error}/>}{connection && <Typography.Text role="status">{connection}</Typography.Text>}
 {older && <Button onClick={() => void loadMessages(selected, epoch.current, older).catch(e => setError(e.message))}>加载更早消息</Button>}
 <div aria-label="问答消息记录">{display.map(run => {
            const current = live?.id === run.id ? live : null, quotes = current && Object.keys(current.quotes).length ? Object.entries(current.quotes).map(([i, c]) => ({ ...c, index: Number(i) })) : run.answer?.claims.map((c, index) => ({ ...c, index })) ?? [];
            return <Card key={run.id} size="small" className="chat-message" title={<Space><Tag>我的问题</Tag><span>{run.question}</span></Space>}><Space direction="vertical" style={{ width: '100%' }}><Typography.Text role="status">{run.status === 'running' ? stageLabel[current?.stage ?? run.stage] : run.status === 'cancelled' ? '已停止；未产生完整回答。' : run.status === 'restricted' ? '依据的访问权限已变化，回答已隐藏。' : run.status === 'failed' ? `本次运行失败（${run.error_code ?? '服务不可用'}），不作为完整回答。` : run.answer?.message ?? '运行已结束。'}</Typography.Text>
 {quotes.map(c => { const e = current?.sources[c.evidence_id] ?? run.answer?.sources.find(s => s.evidence_id === c.evidence_id); return e && <div key={c.index}><blockquote className="parsed-text">{c.quote}</blockquote><Button type="link" onClick={() => void verify(run, e, c.quote)}>{c.evidence_id} · {e.title} · v{e.version_no} · 定位原文</Button></div>; })}
 <Space wrap>{run.status === 'running' && <Button disabled={busy} danger onClick={() => void cancel(run)}>停止本次回答</Button>}{terminal(run) && <Button disabled={busy || !!active} onClick={() => void regenerate(run)}>重新生成</Button>}{run.status === 'completed' && run.answer && <><Button aria-pressed={run.feedback === 'helpful'} onClick={() => void vote(run, 'helpful')}>有帮助{run.feedback === 'helpful' ? ' ✓' : ''}</Button><Button aria-pressed={run.feedback === 'unhelpful'} onClick={() => void vote(run, 'unhelpful')}>无帮助{run.feedback === 'unhelpful' ? ' ✓' : ''}</Button></>}</Space></Space></Card>;
        })}</div>
 <Modal title="回答来源的问题反馈" open={!!correctionSource} onCancel={()=>setCorrectionSource(null)} footer={null} width={900} destroyOnHidden>{correctionSource&&<CorrectionsPanel key={correctionSource.chunk_id} documentId={correctionSource.document_id} versionId={correctionSource.version_id} blockId={correctionSource.spans[0]?.block_id} session={session} onExpired={onExpired}/>}</Modal>
 <Input.TextArea aria-label="问答问题" rows={3} maxLength={1200} value={question} disabled={busy || !!active || !!submission.current} onChange={e => { setQuestion(e.target.value); if (submission.current && submission.current.question !== e.target.value.trim())
        setError('上次提交尚未确认，请先恢复会话；重试将沿用原问题。'); }} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void send();
    } }} placeholder="向企业资料提问，Ctrl+Enter 提交"/><Button type="primary" loading={busy} disabled={!question.trim() || !!active} onClick={() => void send()}>{submission.current ? '重试同次提交' : '发送问题'}</Button>
 {source && <div ref={sourcePanel} tabIndex={-1} aria-label="回答来源定位"><Card size="small" title="回答来源已核验"><Button onClick={()=>setCorrectionSource(source.evidence)}>报告这条来源的问题</Button><Typography.Paragraph>{source.evidence.title} · v{source.evidence.version_no} · {source.evidence.heading_path.join(' / ')}</Typography.Paragraph><Typography.Paragraph>{source.evidence.spans.map(s => s.source.type === 'pdf' ? `第 ${s.source.page} 页` : s.source.type === 'text' ? `第 ${s.source.line_start}—${s.source.line_end} 行` : `Word段落 ${s.source.paragraph_index ?? '—'} / 表格 ${s.source.table_index ?? '—'}`).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}</Typography.Paragraph><pre className="parsed-text">{(() => { const pos = source.evidence.snippet.indexOf(source.quote); return pos < 0 ? source.evidence.snippet : <>{source.evidence.snippet.slice(0, pos)}<mark>{source.quote}</mark>{source.evidence.snippet.slice(pos + source.quote.length)}</>; })()}</pre>{source.evidence.download_url && <Button href={source.evidence.download_url}>下载确切版本原文</Button>}</Card></div>}
 </Space></Card>;
}
