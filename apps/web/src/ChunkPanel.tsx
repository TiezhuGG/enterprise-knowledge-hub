import {useEffect,useState} from 'react';
import {Alert,Button,Card,Space,Tag,Typography} from 'antd';
import type {ChunkPreview,DocumentVersion,ChunkSpan} from '@zhiheng/contracts';
const warnings:Record<string,string>={CHUNK_TABLE_HEADER_UNKNOWN:'原表没有可靠表头；已保留行位置，请核对原文。',CHUNK_MERGED_TABLE_REVIEW:'表格包含合并单元格，拆分后的对应关系需核验。',CHUNK_HEADING_CONTEXT_TRUNCATED:'过长的章节导航已缩短，原结构标题仍可查看。'};
function location(s:ChunkSpan){if(s.source.type==='pdf')return `第 ${s.source.page} 页`;if(s.source.type==='text')return `第 ${s.source.line_start}—${s.source.line_end} 行`;return s.source.table_index!==undefined?`正文表 ${s.source.table_index+1}`:`正文段 ${(s.source.paragraph_index??0)+1}`}
export function ChunkPanel({documentId,version,onExpired,onSource}:{documentId:string;version:DocumentVersion;onExpired:()=>void;onSource:(blockId:string)=>void}){
 const [preview,setPreview]=useState<ChunkPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState<Set<string>>(new Set());
 async function load(cursor?:string,signal?:AbortSignal){setBusy(true);setError('');try{const response=await fetch(`/api/v1/documents/${documentId}/versions/${version.id}/chunks?limit=5${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});if(!response.ok){if(response.status===401)onExpired();throw new Error(response.status===409?'分块结果尚未就绪，请查看处理任务后重试。':response.status===404?'内容不可用或无权访问。':'分块预览暂时不可用，请重试。')}const {data}:{data:ChunkPreview}=await response.json();if(signal?.aborted)return;setPreview(old=>cursor&&old?{...data,result:{...data.result,chunks:[...old.result.chunks,...data.result.chunks]}}:data)}catch(cause){if(signal?.aborted)return;setPreview(null);setError(cause instanceof Error?cause.message:'预览失败。')}finally{if(!signal?.aborted)setBusy(false)}}
 useEffect(()=>{const abort=new AbortController();void load(undefined,abort.signal);return()=>abort.abort()},[version.id]);
 return <Space direction="vertical" size="middle" style={{width:'100%'}}>
  <Space wrap><Typography.Text>{version.filename} · v{version.version_no}</Typography.Text><Button disabled={busy} onClick={()=>void load()}>重新加载分块</Button></Space>
  {error&&<Alert type="error" role="alert" showIcon message={error}/>}
  {preview&&<><Alert type="info" showIcon message={`已生成 ${preview.total_chunks} 个片段 · 等待向量索引`} description={`精确重复片段占比 ${(preview.result.metrics.duplicate_ratio*100).toFixed(1)}% · 正文重叠 ${preview.result.metrics.overlap_characters} 字符。重复片段保留各自来源；当前结果尚不可检索或发布。`}/>
   <Typography.Paragraph type="secondary">按章节和段落分块，含章节提示的检索文本最多 {preview.result.policy.max_characters} 字符；长段落重叠约 {preview.result.policy.overlap_characters} 字符，表格分段重复表头。</Typography.Paragraph>
   {!!preview.result.source_warnings.length&&<Alert type="warning" showIcon message={`原文有 ${preview.result.source_warnings.length} 项解析提示，请结合结构原文核验。`}/>}
   {!!preview.result.warnings.length&&<Alert type="warning" showIcon message="分块质量提示" description={[...new Set(preview.result.warnings.map(w=>warnings[w.code]??'存在需要核验的分块结构。'))].join(' ')}/>}
   {preview.result.chunks.map(chunk=><Card key={chunk.id} size="small" title={<Space wrap><Tag>{chunk.kind==='table'?'表格片段':chunk.kind==='code'?'代码片段':'正文片段'}</Tag><span>片段 {chunk.ordinal+1}</span><span>{chunk.retrieval_text.length} 字符</span>{chunk.overlap_characters>0&&<Tag>重叠 {chunk.overlap_characters} 字符</Tag>}</Space>}>
    {!!chunk.heading_path.length&&<Typography.Paragraph type="secondary">{chunk.heading_path.join(' / ')}</Typography.Paragraph>}
    {chunk.table?<><div style={{overflowX:'auto'}}><table className="parsed-table"><tbody>{chunk.table.rows.slice(0,expanded.has(chunk.id)?undefined:50).map((row,ri)=><tr key={ri}>{row.map((cell,ci)=>{const Tag=ri<chunk.table!.header_rows?'th':'td';return <Tag key={ci} colSpan={cell.col_span}>{cell.v_merge==='continue'?'（合并单元格延续）':cell.text}</Tag>})}</tr>)}</tbody></table></div>{chunk.table.rows.length>50&&!expanded.has(chunk.id)&&<Button onClick={()=>setExpanded(old=>new Set([...old,chunk.id]))}>展开表格全部行（当前显示前50行）</Button>}</>:<pre className="parsed-text">{chunk.text}</pre>}
    <Typography.Paragraph type="secondary" style={{marginTop:12,marginBottom:8}}>来源：原文件 v{chunk.provenance.version_no}{chunk.table?(chunk.table.row_start===chunk.table.row_end?' · 仅表头':` · 原表第 ${chunk.table.row_start+1}—${chunk.table.row_end} 行（表头单独保留）`):''}</Typography.Paragraph>
    <Space wrap>{[...new Map(chunk.spans.map(s=>[s.block_id,s])).values()].map(s=><Button size="small" key={s.block_id} onClick={()=>onSource(s.block_id)}>查看结构原文 · {location(s)}</Button>)}</Space>
   </Card>)}
   {preview.page.next_cursor&&<Button loading={busy} onClick={()=>void load(preview.page.next_cursor!)}>加载更多片段</Button>}
  </>}
 </Space>;
}
