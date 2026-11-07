import { IndexPanel } from './IndexPanel';
import { ChunkPanel } from './ChunkPanel';
import { useEffect, useRef, useState } from 'react';
import { ParsedPanel } from './ParsedPanel';
import { Modal } from 'antd';
import { JobsPanel } from './JobsPanel';
import { Alert, Button, Card, Empty, List, Space, Tag, Typography } from 'antd';
import type { DocumentVersion, FinalizedUpload, KnowledgeBase, KnowledgeDocument, ResourcePage, SessionInfo, UploadTicket } from '@zhiheng/contracts';
const failure=(status:number)=>status===404?'内容不可用或无权访问。':status===401?'登录已失效，请重新登录。':status===410?'上传票据已过期，请重新上传。':status===413?'文件超过当前上传大小限制。':status===415?'文件格式或实际内容不受支持，请使用 UTF-8 TXT、Markdown、PDF 或 DOCX。':status===422?'文件大小或校验值不一致，请重新选择文件。':status===409?'文档或上传状态已变化，请刷新并确认目标后重试。':status===429?'上传额度或并发已达上限，请稍后重试。':'服务暂时不可用，请重试。';
interface Attempt {fingerprint:string;key:string;ticket?:UploadTicket;finalizeKey:string}
export function DocumentsPanel({kb,session,onExpired}:{kb:KnowledgeBase;session:SessionInfo;onExpired:()=>void}) {
  const [indexVersion,setIndexVersion]=useState<DocumentVersion|null>(null);
  const [chunkVersion,setChunkVersion]=useState<DocumentVersion|null>(null),[focusBlockId,setFocusBlockId]=useState<string|undefined>();
  const [parsedVersion,setParsedVersion]=useState<DocumentVersion|null>(null);
  const [documents,setDocuments]=useState<KnowledgeDocument[]>([]),[next,setNext]=useState<string|null>(null);
  const [versions,setVersions]=useState<DocumentVersion[]>([]),[versionNext,setVersionNext]=useState<string|null>(null),[viewing,setViewing]=useState<KnowledgeDocument|null>(null);
  const [target,setTarget]=useState<KnowledgeDocument|null>(null),[file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const attempt=useRef<Attempt|null>(null),controller=useRef<AbortController|null>(null),input=useRef<HTMLInputElement|null>(null);
  async function request(path:string,init:RequestInit={}) {
    const response=await fetch(`/api/v1${path}`,{...init,signal:controller.current?.signal??AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,...init.headers}});
    if(!response.ok){if(response.status===401)onExpired();if(response.status===410||response.status===409)attempt.current=null;throw new Error(failure(response.status))}return response;
  }
  async function load(cursor?:string){
    const page:ResourcePage<KnowledgeDocument>=await(await request(`/knowledge-bases/${kb.id}/documents?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();
    setDocuments(old=>cursor?[...old,...page.data]:page.data);setNext(page.page.next_cursor);
  }
  async function refresh(){setError('');try{await load()}catch(cause){setDocuments([]);setVersions([]);setError(cause instanceof Error?cause.message:'加载失败。')}}
  useEffect(()=>{void refresh();return()=>controller.current?.abort()},[]);
  async function showVersions(doc:KnowledgeDocument,cursor?:string){
    setError('');try{const page:ResourcePage<DocumentVersion>=await(await request(`/documents/${doc.id}/versions?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();setViewing(doc);setVersions(old=>cursor?[...old,...page.data]:page.data);setVersionNext(page.page.next_cursor)}catch(cause){setVersions([]);setError(cause instanceof Error?cause.message:'版本读取失败。')}
  }
  function chooseTarget(doc:KnowledgeDocument|null){attempt.current=null;setTarget(doc);setMessage('');setError('');setFile(null);if(input.current)input.current.value=''}
  async function upload(){
    if(!file)return;setBusy(true);setError('');setMessage('正在校验文件…');controller.current=new AbortController();
    const timer=setTimeout(()=>controller.current?.abort(),90000);
    try{
      if(file.size<1||file.size>52428800)throw new Error('文件为空或超过 50 MiB，请重新选择。');
      const bytes=await file.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);const sha=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
      const suffix=file.name.toLowerCase().split('.').at(-1),mime=suffix==='pdf'?'application/pdf':suffix==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':suffix==='md'?'text/markdown':'text/plain';
      const body=JSON.stringify({kb_id:kb.id,...(target?{document_id:target.id}:{}),filename:file.name,size:file.size,mime,sha256:sha});
      if(attempt.current?.fingerprint!==body)attempt.current={fingerprint:body,key:crypto.randomUUID(),finalizeKey:crypto.randomUUID()};
      const current=attempt.current!;
      if(!current.ticket){setMessage('正在申请上传…');current.ticket=(await(await request('/upload-tickets',{method:'POST',headers:{'Idempotency-Key':current.key},body})).json()).data}
      else current.ticket=(await(await request(`/upload-tickets/${current.ticket.ticket_id}`)).json()).data;
      const ticket=current.ticket!;
      if(ticket.status==='open') {setMessage('正在上传原文件…');await request(ticket.upload.url.replace('/api/v1',''),{method:'PUT',headers:ticket.upload.headers,body:new Blob([bytes],{type:mime})})}
      setMessage('正在登记不可变版本…');
      const result:FinalizedUpload=(await(await request(ticket.finalize_url.replace('/api/v1',''),{method:'POST',headers:{'Idempotency-Key':current.finalizeKey},body:JSON.stringify({sha256:sha})})).json()).data;
      attempt.current=null;setFile(null);if(input.current)input.current.value='';setMessage(`版本 v${result.version_no} 已登记，待安全检查与解析。`);
      await load();const doc=(await(await request(`/documents/${result.document_id}`)).json()).data;await showVersions(doc);
    }catch(cause){setMessage('');setError(controller.current?.signal.aborted?'上传已停止，可再次点击上传以恢复。':cause instanceof Error?cause.message:'上传失败，请重试。')}
    finally{clearTimeout(timer);controller.current=null;setBusy(false)}
  }
  return <Space direction="vertical" size="middle" style={{width:'100%'}}>
    {error&&<Alert role="alert" type="error" showIcon message={error}/>}
    {message&&<Alert role="status" type="info" showIcon message={message}/>}
    {kb.capabilities.includes('write')&&<Card size="small" title={target?`上传新版本：${target.title}`:'上传新文档'}>
      <Space direction="vertical" style={{width:'100%'}}>
        <Typography.Text type="secondary">支持 UTF-8 TXT、Markdown、PDF 和 DOCX。上传后保持草稿，可查看解析结构；索引与发布将在后续接入。</Typography.Text>
        <input ref={input} aria-label="选择上传文件" type="file" accept=".txt,.md,.pdf,.docx" disabled={busy} onChange={event=>{attempt.current=null;setFile(event.target.files?.[0]??null);setError('');setMessage('')}}/>
        <Space wrap><Button type="primary" loading={busy} disabled={!file} onClick={()=>void upload()}>上传并登记版本</Button>{busy&&<Button onClick={()=>controller.current?.abort()}>停止上传</Button>}{target&&!busy&&<Button onClick={()=>chooseTarget(null)}>改为新文档</Button>}</Space>
      </Space>
    </Card>}
    <Button disabled={busy} onClick={()=>void refresh()}>刷新文档</Button>
    <List className="knowledge-list" dataSource={documents} locale={{emptyText:<Empty description="暂无可见文档"/>}} renderItem={doc=><List.Item actions={[
      <Button key="versions" disabled={busy} onClick={()=>void showVersions(doc)}>查看版本</Button>,
      ...(doc.capabilities.includes('write')?[<Button key="replace" disabled={busy} onClick={()=>chooseTarget(doc)}>上传新版本</Button>]:[]),
    ]}><List.Item.Meta title={doc.title} description={doc.status==='draft'?'草稿 · 尚未发布':doc.status==='active'?'已发布':'已归档'}/></List.Item>}/>
    {next&&<Button disabled={busy} onClick={()=>void load(next).catch(()=>setError('文档加载失败，请重试。'))}>加载更多文档</Button>}
    {viewing&&viewing.capabilities.some(action=>['write','manage'].includes(action))&&<JobsPanel key={viewing.id} document={viewing} session={session} onExpired={onExpired}/>}
    {viewing&&<Card size="small" title={`${viewing.title} · 版本`}>
      <List className="knowledge-list" dataSource={versions} locale={{emptyText:'暂无可见版本'}} renderItem={version=><List.Item actions={[<Button key="index" onClick={()=>setIndexVersion(version)}>索引详情</Button>,<Button key="chunks" onClick={()=>setChunkVersion(version)}>分块预览</Button>,<Button key="parsed" onClick={()=>{setFocusBlockId(undefined);setParsedVersion(version)}}>解析预览</Button>,...(viewing.capabilities.includes('download')?[<Button key="download" href={`/api/v1/documents/${viewing.id}/versions/${version.id}/content`}>下载原文件</Button>]:[])]}>
        <List.Item.Meta title={<Space wrap>{`v${version.version_no}`}{version.is_latest&&<Tag>最新上传</Tag>}{version.is_published&&<Tag>已发布</Tag>}</Space>} description={`${version.filename} · ${version.size} 字节 · ${version.scan_status==='pending'?'安全检查待完成':version.scan_status==='clean'?'安全检查通过':'已拒绝'}`}/>
      </List.Item>}/>{versionNext&&<Button onClick={()=>void showVersions(viewing,versionNext)}>加载更多版本</Button>}
    </Card>}
    <Modal title="向量索引与模型版本" open={!!indexVersion} onCancel={()=>setIndexVersion(null)} footer={null} width={800} destroyOnHidden>{viewing&&indexVersion&&<IndexPanel key={indexVersion.id} documentId={viewing.id} version={indexVersion} session={session} canWrite={viewing.capabilities.includes('write')} onExpired={onExpired}/>}</Modal>
    <Modal title="分块与来源核验" open={!!chunkVersion} onCancel={()=>setChunkVersion(null)} footer={null} width={900} destroyOnHidden>{viewing&&chunkVersion&&<ChunkPanel key={chunkVersion.id} documentId={viewing.id} version={chunkVersion} onExpired={onExpired} onSource={blockId=>{setFocusBlockId(blockId);setParsedVersion(chunkVersion);setChunkVersion(null)}}/>}</Modal>
    <Modal title="文档结构与原文定位" open={!!parsedVersion} onCancel={()=>setParsedVersion(null)} footer={null} width={900} destroyOnHidden>{viewing&&parsedVersion&&<ParsedPanel key={`${parsedVersion.id}:${focusBlockId??"all"}`} focusBlockId={focusBlockId} documentId={viewing.id} version={parsedVersion} allowDownload={viewing.capabilities.includes('download')} session={session} onExpired={onExpired}/>}</Modal>
  </Space>;
}
