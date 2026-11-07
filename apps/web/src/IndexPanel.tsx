import {useEffect,useRef,useState} from 'react';import {Alert,Button,Card,Descriptions,Space,Tag,Typography} from 'antd';
import type {DenseGenerationView,DocumentVersion,SessionInfo} from '@zhiheng/contracts';
export function IndexPanel({documentId,version,session,canWrite,onExpired}:{documentId:string;version:DocumentVersion;session:SessionInfo;canWrite:boolean;onExpired:()=>void}){
 const pendingKey=useRef<string|null>(null);
 const [rows,setRows]=useState<DenseGenerationView[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const path=`/api/v1/documents/${documentId}/versions/${version.id}/index-generations`;
 async function load(){setError('');try{const r=await fetch(path,{signal:AbortSignal.timeout(10000)});if(!r.ok){if(r.status===401)onExpired();throw new Error(r.status===404?'内容不可用或无权访问。':'索引状态暂时不可用。')}setRows((await r.json()).data)}catch(e){setRows([]);setError(e instanceof Error?e.message:'读取失败。')}}
 useEffect(()=>{void load()},[version.id]);
 async function rebuild(){setBusy(true);setError('');try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':pendingKey.current??(pendingKey.current=crypto.randomUUID())},body:JSON.stringify({reverify:true}),signal:AbortSignal.timeout(10000)});if(!r.ok){if(r.status===401)onExpired();throw new Error(r.status===409?'任务正在运行、已取消或尚未分块，请查看处理任务。':r.status===503?'索引服务尚未配置，请联系维护者。':'当前无法重建索引，请检查权限与服务配置。')}pendingKey.current=null;await load()}catch(e){setError(e instanceof Error?e.message:'操作失败。')}finally{setBusy(false)}}
 return <Space direction="vertical" size="middle" style={{width:'100%'}}><Typography.Text>{version.filename} · v{version.version_no}</Typography.Text><Alert type="info" showIcon message="向量索引是派生产物，索引就绪不代表已发布。" description="模型或维度变更会创建独立代际；读取与后续检索仍须核对当前版本和权限。"/>
 <Space wrap><Button disabled={busy} onClick={()=>void load()}>刷新索引状态</Button>{canWrite&&<Button loading={busy} onClick={()=>void rebuild()}>重新校验并构建索引</Button>}</Space>
 {error&&<Alert type="error" role="alert" showIcon message={error}/>}{!rows.length&&!error&&<Alert type="warning" showIcon message="尚无索引代际，请查看处理任务与模型配置。"/>}
 {rows.map(g=><Card key={g.id} size="small" title={<Space wrap><span>索引代际 {g.generation_no}</span><Tag>{{building:'构建中',ready:'索引就绪',failed:'构建失败',cancelled:'已取消'}[g.status]}</Tag></Space>}><Descriptions column={1} size="small" items={[
 {key:'model',label:'嵌入模型',children:g.model},{key:'revision',label:'固定版本',children:<Typography.Text style={{overflowWrap:'anywhere'}}>{g.revision}</Typography.Text>},{key:'dimension',label:'向量维度',children:g.dimension},{key:'count',label:'读回验证',children:`${g.indexed_count} / ${g.chunk_count} 个片段`},{key:'cache',label:'缓存命中次数',children:g.cache_hits},{key:'inputs',label:'新增模型输入',children:g.provider_inputs},{key:'tokens',label:'服务报告的输入 tokens',children:g.tokens??'服务未报告'},{key:'scope',label:'必需索引',children:'稠密向量（dense）'}]}/><Typography.Paragraph type="secondary" style={{marginTop:12}}>缓存按租户、模型空间和完整检索文本隔离；模型调用结果不明时停止自动重发，费用需结合服务用量与资源成本核算。</Typography.Paragraph></Card>)}
 </Space>;
}
