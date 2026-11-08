import {FeedbackPanel} from './FeedbackPanel';
import {LabPanel} from './LabPanel';
import {ReleasesPanel} from './ReleasesPanel';
import {ConnectorsPanel} from './ConnectorsPanel';
import {CleanupsPanel} from './CleanupsPanel';
import {CorrectionsPanel} from './CorrectionsPanel';
import { IndexPanel } from './IndexPanel';
import { ChunkPanel } from './ChunkPanel';
import { useEffect, useRef, useState } from 'react';
import { ParsedPanel } from './ParsedPanel';
import { Modal } from 'antd';
import { JobsPanel } from './JobsPanel';
import { Alert, Button, Card, Empty, Input, List, Select, Space, Tag, Typography } from 'antd';
import type { DocumentVersion, FinalizedUpload, KnowledgeBase, KnowledgeDocument, ResourcePage, SessionInfo, UploadTicket } from '@zhiheng/contracts';
const failure=(status:number)=>status===404?'内容不可用或无权访问。':status===401?'登录已失效，请重新登录。':status===410?'上传票据已过期，请重新上传。':status===413?'文件超过当前上传大小限制。':status===415?'文件格式或实际内容不受支持，请使用 UTF-8 TXT、Markdown、PDF 或 DOCX。':status===422?'文件大小或校验值不一致，请重新选择文件。':status===412?'文档或权限已变化，请关闭确认框，刷新文档后重试。':status===409?'文档或上传状态已变化，请刷新并确认目标后重试。':status===429?'上传额度或并发已达上限，请稍后重试。':'服务暂时不可用，请重试。';
interface Attempt {fingerprint:string;key:string;ticket?:UploadTicket;finalizeKey:string}
export function DocumentsPanel({kb,session,onExpired}:{kb:KnowledgeBase;session:SessionInfo;onExpired:()=>void}) {
  const [deleting,setDeleting]=useState<KnowledgeDocument|null>(null),[deleteKey,setDeleteKey]=useState(''),[deleteEtag,setDeleteEtag]=useState('');
  const [correctionVersion,setCorrectionVersion]=useState<DocumentVersion|null>(null),[query,setQuery]=useState(''),[state,setState]=useState('');
  const [indexVersion,setIndexVersion]=useState<DocumentVersion|null>(null);
  const [chunkVersion,setChunkVersion]=useState<DocumentVersion|null>(null),[focusBlockId,setFocusBlockId]=useState<string|undefined>();
  const [parsedVersion,setParsedVersion]=useState<DocumentVersion|null>(null);
  const [documents,setDocuments]=useState<KnowledgeDocument[]>([]),[next,setNext]=useState<string|null>(null);
  const [versions,setVersions]=useState<DocumentVersion[]>([]),[versionNext,setVersionNext]=useState<string|null>(null),[viewing,setViewing]=useState<KnowledgeDocument|null>(null);
  const [target,setTarget]=useState<KnowledgeDocument|null>(null),[file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const listEpoch=useRef(0),versionEpoch=useRef(0),alive=useRef(true);
  function clearContext(){versionEpoch.current++;setViewing(null);setVersions([]);setVersionNext(null);setIndexVersion(null);setChunkVersion(null);setParsedVersion(null);setCorrectionVersion(null)}
  const attempt=useRef<Attempt|null>(null),controller=useRef<AbortController|null>(null),input=useRef<HTMLInputElement|null>(null);
  async function request(path:string,init:RequestInit={}) {
    const response=await fetch(`/api/v1${path}`,{...init,signal:controller.current?.signal??AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,...init.headers}});
    if(!response.ok){if(response.status===401)onExpired();if(response.status===410||response.status===409)attempt.current=null;throw new Error(failure(response.status))}return response;
  }
  async function load(cursor?:string){
    const epoch=listEpoch.current;const page:ResourcePage<KnowledgeDocument>=await(await request(`/knowledge-bases/${kb.id}/documents?limit=20&q=${encodeURIComponent(query)}${state?`&status=${state}`:''}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();
    if(!alive.current||epoch!==listEpoch.current)return;setDocuments(old=>cursor?[...new Map([...old,...page.data].map(d=>[d.id,d])).values()]:page.data);setNext(page.page.next_cursor);
  }
  async function refresh(){listEpoch.current++;clearContext();setError('');try{await load()}catch(cause){setDocuments([]);setVersions([]);setError(cause instanceof Error?cause.message:'加载失败。')}}
  useEffect(()=>{setDocuments([]);void refresh()},[query,state]);
  useEffect(()=>()=>{alive.current=false;controller.current?.abort()},[]);
  async function showVersions(doc:KnowledgeDocument,cursor?:string){
    if(!cursor)clearContext();const epoch=versionEpoch.current;setError('');try{const page:ResourcePage<DocumentVersion>=await(await request(`/documents/${doc.id}/versions?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();if(!alive.current||epoch!==versionEpoch.current)return;setViewing(doc);setVersions(old=>cursor?[...new Map([...old,...page.data].map(v=>[v.id,v])).values()]:page.data);setVersionNext(page.page.next_cursor)}catch(cause){setVersions([]);setError(cause instanceof Error?cause.message:'版本读取失败。')}
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
  async function beginDelete(doc:KnowledgeDocument){try{setError('');const r=await request(`/documents/${doc.id}`);setDeleteEtag(r.headers.get('etag')!);setDeleting((await r.json()).data);setDeleteKey(crypto.randomUUID())}catch(e){setError((e as Error).message)}}
  async function removeDocument(){if(!deleting)return;setBusy(true);setError('');try{await request(`/documents/${deleting.id}`,{method:'DELETE',headers:{'If-Match':deleteEtag,'Idempotency-Key':deleteKey}});if(target?.id===deleting.id)chooseTarget(null);setDeleting(null);setMessage('文档访问已失效，物理清理进度见删除与清理记录。');await refresh()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Space direction="vertical" size="middle" style={{width:'100%'}}>
    <Modal title="删除文档" open={!!deleting} onCancel={()=>setDeleting(null)} onOk={()=>void removeDocument()} okText="确认删除" okButtonProps={{danger:true}} confirmLoading={busy}><Typography.Paragraph>删除“{deleting?.title}”后无法恢复；原文、历史引用和后续检索会立即不可用。对象和向量在保留期后异步清理，可查看处理记录。</Typography.Paragraph>{error&&<Alert type="error" message={error}/>}</Modal>
    {kb.capabilities.includes('read')&&<FeedbackPanel kb={kb} session={session} onExpired={onExpired}/>}
    {['manage','read'].every(a=>kb.capabilities.includes(a as never))&&<LabPanel kb={kb} session={session} onExpired={onExpired}/>}
    {['manage','read','write','publish'].every(a=>kb.capabilities.includes(a as never))&&<ReleasesPanel kb={kb} session={session} onExpired={onExpired}/>}
    {kb.capabilities.includes('manage')&&<ConnectorsPanel kb={kb} session={session} onExpired={onExpired}/>}
    {kb.capabilities.includes('delete')&&<CleanupsPanel key={message} kb={kb} session={session} onExpired={onExpired}/>}
    {error&&<Alert role="alert" type="error" showIcon message={error}/>}
    {message&&<Alert role="status" type="info" showIcon message={message}/>}
    {kb.capabilities.includes('write')&&<Card size="small" title={target?`上传新版本：${target.title}`:'上传新文档'}>
      <Space direction="vertical" style={{width:'100%'}}>
        <Typography.Text type="secondary">支持 UTF-8 TXT、Markdown、PDF 和 DOCX。上传后保持草稿，可查看解析结构；已接入分块与向量索引；安全检查和发布仍需对应流程。</Typography.Text>
        <input ref={input} aria-label="选择上传文件" type="file" accept=".txt,.md,.pdf,.docx" disabled={busy} onChange={event=>{attempt.current=null;setFile(event.target.files?.[0]??null);setError('');setMessage('')}}/>
        <Space wrap><Button type="primary" loading={busy} disabled={!file} onClick={()=>void upload()}>上传并登记版本</Button>{busy&&<Button onClick={()=>controller.current?.abort()}>停止上传</Button>}{target&&!busy&&<Button onClick={()=>chooseTarget(null)}>改为新文档</Button>}</Space>
      </Space>
    </Card>}
    <Space wrap><Input.Search aria-label="搜索文档" placeholder="搜索可见文档" disabled={busy} allowClear onSearch={setQuery} style={{width:220}}/><Select aria-label="文档状态筛选" disabled={busy} value={state} onChange={setState} style={{width:140}} options={[{value:"",label:"全部文档状态"},{value:"draft",label:"草稿"},{value:"active",label:"使用中"},{value:"archived",label:"已归档"}]}/><Button disabled={busy} onClick={()=>void refresh()}>刷新文档</Button></Space>
    <List className="knowledge-list" dataSource={documents} locale={{emptyText:<Empty description="暂无可见文档"/>}} renderItem={doc=><List.Item actions={[
      ...(doc.capabilities.includes('delete')?[<Button key="delete" danger disabled={busy} onClick={()=>void beginDelete(doc)}>删除文档</Button>]:[]),
      <Button key="versions" disabled={busy} onClick={()=>void showVersions(doc)}>查看版本</Button>,
      ...(doc.capabilities.includes('write')?[<Button key="replace" disabled={busy} onClick={()=>chooseTarget(doc)}>上传新版本</Button>]:[]),
    ]}><List.Item.Meta title={doc.title} description={doc.status==='draft'?'草稿 · 尚未发布':doc.status==='active'?'使用中（发布状态见版本）':'已归档'}/></List.Item>}/>
    {next&&<Button disabled={busy} onClick={()=>void load(next).catch(()=>setError('文档加载失败，请重试。'))}>加载更多文档</Button>}
    {viewing&&viewing.capabilities.some(action=>['write','manage'].includes(action))&&<JobsPanel key={viewing.id} document={viewing} session={session} onExpired={onExpired}/>}
    {viewing&&<Card size="small" title={`${viewing.title} · 版本`}>
      <List className="knowledge-list" dataSource={versions} locale={{emptyText:'暂无可见版本'}} renderItem={version=><List.Item actions={[<Button key="correction" onClick={()=>setCorrectionVersion(version)}>问题反馈与纠错</Button>,<Button key="index" onClick={()=>setIndexVersion(version)}>索引详情</Button>,<Button key="chunks" onClick={()=>setChunkVersion(version)}>分块预览</Button>,<Button key="parsed" onClick={()=>{setFocusBlockId(undefined);setParsedVersion(version)}}>解析预览</Button>,...(viewing.capabilities.includes('download')?[<Button key="download" href={`/api/v1/documents/${viewing.id}/versions/${version.id}/content`}>下载原文件</Button>]:[])]}>
        <List.Item.Meta title={<Space wrap>{`v${version.version_no}`}{version.is_latest&&<Tag>最新上传</Tag>}{version.is_published&&<Tag>已发布</Tag>}</Space>} description={`${version.filename} · ${version.size} 字节 · ${version.scan_status==='pending'?'安全检查待完成':version.scan_status==='clean'?'安全检查通过':'已拒绝'}`}/>
      </List.Item>}/>{versionNext&&<Button onClick={()=>void showVersions(viewing,versionNext)}>加载更多版本</Button>}
    </Card>}
    <Modal title="版本问题与人工纠错" open={!!correctionVersion} onCancel={()=>setCorrectionVersion(null)} footer={null} width={900} destroyOnHidden>{viewing&&correctionVersion&&<CorrectionsPanel key={correctionVersion.id} documentId={viewing.id} versionId={correctionVersion.id} session={session} onExpired={onExpired}/>}</Modal>
    <Modal title="向量索引与模型版本" open={!!indexVersion} onCancel={()=>setIndexVersion(null)} footer={null} width={800} destroyOnHidden>{viewing&&indexVersion&&<IndexPanel key={indexVersion.id} documentId={viewing.id} version={indexVersion} session={session} canWrite={viewing.capabilities.includes('write')} canPublish={viewing.capabilities.includes('publish')} onExpired={onExpired}/>}</Modal>
    <Modal title="分块与来源核验" open={!!chunkVersion} onCancel={()=>setChunkVersion(null)} footer={null} width={900} destroyOnHidden>{viewing&&chunkVersion&&<ChunkPanel key={chunkVersion.id} documentId={viewing.id} version={chunkVersion} onExpired={onExpired} onSource={blockId=>{setFocusBlockId(blockId);setParsedVersion(chunkVersion);setChunkVersion(null)}}/>}</Modal>
    <Modal title="文档结构与原文定位" open={!!parsedVersion} onCancel={()=>setParsedVersion(null)} footer={null} width={900} destroyOnHidden>{viewing&&parsedVersion&&<ParsedPanel key={`${parsedVersion.id}:${focusBlockId??"all"}`} focusBlockId={focusBlockId} documentId={viewing.id} version={parsedVersion} allowDownload={viewing.capabilities.includes('download')} session={session} onExpired={onExpired}/>}</Modal>
  </Space>;
}
