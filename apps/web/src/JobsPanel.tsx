import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, List, Modal, Space, Tag, Typography } from 'antd';
import type { IngestionDetails, IngestionJob, KnowledgeDocument, ResourcePage, SessionInfo } from '@zhiheng/contracts';
const labels={queued:'排队中',running:'处理中',retry_wait:'等待重试',waiting_dependency:'等待解析服务',succeeded:'处理完成',failed:'失败',cancelled:'已取消'};
const reasons:Record<string,string>={PARSER_NOT_CONFIGURED:'等待解析服务接入，文件尚未解析。',SOURCE_UNAVAILABLE:'原文件存储暂不可用。',SOURCE_INTEGRITY_MISMATCH:'原文件校验失败，请上传新版本。',ACCESS_REVOKED:'执行身份的文档权限已变化。',LEASE_EXPIRED:'执行中断，正在恢复或等待重试。',WORKER_ERROR:'执行中断，请重试。',WORKER_DEADLINE:'处理超时。',USER_CANCELLED:'已停止后续处理。',SOURCE_REJECTED:'文件安全状态不允许处理。'};
const retryable=new Set(['SOURCE_UNAVAILABLE','LEASE_EXPIRED','WORKER_ERROR','WORKER_DEADLINE','ACCESS_REVOKED']);
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
export function JobsPanel({document,session,onExpired}:{document:KnowledgeDocument;session:SessionInfo;onExpired:()=>void}){
  const [rows,setRows]=useState<IngestionJob[]>([]),[next,setNext]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[details,setDetails]=useState<IngestionDetails|null>(null);
  async function request(path:string,init:RequestInit={}){
    const response=await fetch(`/api/v1${path}`,{...init,signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,...init.headers}});
    if(!response.ok){if(response.status===401)onExpired();throw new Error(response.status===404?'任务不可用或当前无权访问。':response.status===409?'当前状态不允许此操作，请刷新任务。':'任务服务暂时不可用，请重试。')}return response;
  }
  async function load(cursor?:string){const page:ResourcePage<IngestionJob>=await(await request(`/jobs?document_id=${document.id}&limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();setRows(old=>cursor?[...old,...page.data]:page.data);setNext(page.page.next_cursor)}
  async function refresh(){try{await load();setError('')}catch(cause){setRows([]);setNext(null);setDetails(null);setError(cause instanceof Error?cause.message:'任务加载失败。')}}
  useEffect(()=>{let active=true,polling=false;const controller=new AbortController();
    const poll=async()=>{if(polling)return;polling=true;try{const response=await fetch(`/api/v1/jobs?document_id=${document.id}&limit=20`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});if(!response.ok){if(response.status===401&&active)onExpired();throw new Error('任务不可用或当前无权访问。')}const page:ResourcePage<IngestionJob>=await response.json();if(active){setRows(page.data);setNext(page.page.next_cursor);setError('')}}catch(cause){if(active){setRows([]);setNext(null);setDetails(null);setError(cause instanceof Error?cause.message:'任务读取失败。')}}finally{polling=false}};
    void poll();const timer=setInterval(()=>void poll(),2000);return()=>{active=false;clearInterval(timer);controller.abort()};
  },[document.id,onExpired]);
  async function show(job:IngestionJob){try{setDetails((await(await request(`/jobs/${job.id}`)).json()).data);setError('')}catch(cause){setError(cause instanceof Error?cause.message:'详情读取失败。')}}
  async function act(job:IngestionJob,action:'retry'|'cancel'){
    setBusy(true);setError('');try{await request(`/jobs/${job.id}/${action}`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:'{}'});setDetails(null);await refresh()}catch(cause){setError(cause instanceof Error?cause.message:'操作未完成，请重试。')}finally{setBusy(false)}
  }
  return <Card title="处理任务" size="small">
    {error&&<Alert type="error" role="alert" showIcon message={error}/>}
    <List className="knowledge-list" dataSource={rows} locale={{emptyText:<Empty description="暂无可见任务"/>}} renderItem={job=><List.Item actions={[
      <Button key="details" disabled={busy} onClick={()=>void show(job)}>任务详情</Button>,
      ...(job.status==='failed'&&retryable.has(job.error_code??'')&&document.capabilities.includes('write')?[<Button key="retry" disabled={busy} onClick={()=>void act(job,'retry')}>重试任务</Button>]:[]),
      ...(!['succeeded','failed','cancelled'].includes(job.status)&&document.capabilities.some(a=>['write','manage'].includes(a))?[<Button key="cancel" disabled={busy} onClick={()=>void act(job,'cancel')}>取消处理</Button>]:[]),
    ]}><List.Item.Meta title={<Space wrap>{`版本 v${job.version_no}`}<Tag>{labels[job.status]}</Tag>{job.cancel_requested&&job.status==='running'&&<Tag>正在取消</Tag>}</Space>} description={<Space direction="vertical"><span>{job.cancel_requested&&job.status==='running'?'正在停止后续处理。':job.error_code?reasons[job.error_code]??'等待处理。':job.status==='running'?'正在校验原文件。':'等待可用的处理资源。'}</span><span>{`本轮尝试 ${job.attempt_count}/${job.max_attempts} · 累计执行 ${job.total_attempts} 次`}</span>{job.status==='retry_wait'&&job.next_run_at&&<span>下次重试：{date(job.next_run_at)}（北京时间）</span>}</Space>}/></List.Item>}/>
    {next&&<Button disabled={busy} onClick={()=>void load(next).catch(()=>setError('更多任务加载失败。'))}>加载更多任务</Button>}
    <Modal title="任务执行记录" open={!!details} footer={null} onCancel={()=>setDetails(null)} destroyOnHidden>
      {details&&<><Typography.Paragraph>{`版本 v${details.version_no} · ${labels[details.status]} · 第 ${details.run_no} 轮`}</Typography.Paragraph>
        {details.error_code&&<Alert showIcon type={details.status==='failed'?'error':'info'} message={reasons[details.error_code]??details.error_code}/>}
        <Typography.Title level={5}>最近执行尝试</Typography.Title>
        <List dataSource={details.attempts} locale={{emptyText:'尚未开始执行'}} renderItem={attempt=><List.Item>{`第 ${attempt.run_no} 轮 / 尝试 ${attempt.attempt_no} · ${{running:'执行中',completed:'本次执行结束',failed:'失败',interrupted:'执行中断',cancelled:'已取消'}[attempt.status]??attempt.status} · ${date(attempt.started_at)}`}{attempt.error_code&&<span>{reasons[attempt.error_code]??attempt.error_code}</span>}</List.Item>}/>
        <Typography.Title level={5}>最近状态变化</Typography.Title><List dataSource={details.events} renderItem={event=><List.Item>{`${date(event.occurred_at)} · ${event.stage==='cancel_requested'?'正在取消':labels[event.status as keyof typeof labels]??event.status}`}</List.Item>}/>
      </>}
    </Modal>
  </Card>;
}
