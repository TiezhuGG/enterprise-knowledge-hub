import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { CHUNKER_VERSION,STRUCTURE_PARSER_VERSION,type ChunkSet,type ChunkScope,type KnowledgeChunk,type ParsedBlock,type ParsedDocument,type ChunkSpan } from '@zhiheng/contracts';
export {CHUNKER_VERSION};
export class ChunkFailure extends Error {constructor(readonly code:string){super(code)}}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const MAX=1200,OVERLAP=120,CONTEXT=240,MAX_CHUNKS=10000,MAX_OUTPUT=20971520;
const fail=(code:string):never=>{throw new ChunkFailure(code)};
function uuid(seed:string){const h=hash(seed).slice(0,12)+'8'+hash(seed).slice(13,16)+'a'+hash(seed).slice(17,32);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
// All offsets are UTF-16; never split a surrogate pair even when the limit falls between it.
function boundary(text:string,index:number){if(index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1]!)&&/[\uDC00-\uDFFF]/.test(text[index]!))return index-1;return index}
function startAt(text:string,index:number){return boundary(text,index)===index?index:index+1}
function endAt(text:string,start:number,budget:number){const hard=boundary(text,Math.min(text.length,start+budget));if(hard===text.length)return hard;for(let i=hard;i>start+budget*.55;i--)if(/[。！？.!?;；\n\s]/u.test(text[i-1]!))return boundary(text,i);return hard}
function prefix(path:string[]){const all=path.join(' / ');return all.slice(0,boundary(all,CONTEXT))}
function span(block:ParsedBlock,start=0,end=block.text.length):ChunkSpan{return {block_id:block.id!,block_ordinal:block.ordinal,start,end,source:block.source,role:'body'}}
export async function buildChunks(parsed:ParsedDocument,scope:ChunkScope,strategy:ChunkSet['policy']['strategy']='structure-v1',signal?:AbortSignal):Promise<ChunkSet>{
 if(!['structure-v1','fixed-window-v1'].includes(strategy)||parsed.parser_version!==STRUCTURE_PARSER_VERSION||scope.parser_version!==parsed.parser_version||scope.source_sha256!==parsed.source_sha256||!parsed.blocks.length||parsed.blocks.length>50000||parsed.blocks.some((b,i)=>!b.id||b.ordinal!==i||typeof b.text!=='string'))fail('CHUNK_INVALID_INPUT');
 const chunks:KnowledgeChunk[]=[],warnings:ChunkSet['warnings']=[];let repeatedHeaders=0,excluded=0,work=0;const deadline=Date.now()+15000;
 const check=async()=>{if(++work%64===0)await setImmediate();if(signal?.aborted)fail('CHUNK_CANCELLED');if(Date.now()>deadline)fail('CHUNK_TIMEOUT')};
 const warn=(code:string,b?:ParsedBlock)=>{if(!warnings.some(w=>w.code===code&&w.block_id===b?.id))warnings.push({code,...(b?{block_id:b.id}:{})})};
 const emit=async(text:string,spans:ChunkSpan[],path:string[],kind:KnowledgeChunk['kind']='text',overlap=0,table?:KnowledgeChunk['table'])=>{
  await check();if(!text.trim())return;if(chunks.length>=MAX_CHUNKS)fail('CHUNK_COUNT_LIMIT');
  const context=strategy==='structure-v1'?prefix(path):'',retrieval=context?`${context}\n\n${text}`:text;if(retrieval.length>MAX)fail('CHUNK_LENGTH_LIMIT');
  const ordinal=chunks.length,textHash=hash(text);chunks.push({id:uuid(JSON.stringify([scope.tenant_id,scope.version_id,scope.parsed_artifact_sha256,CHUNKER_VERSION,strategy,ordinal,textHash])),ordinal,kind,text,retrieval_text:retrieval,text_sha256:textHash,retrieval_sha256:hash(retrieval),heading_path:[...path],spans,overlap_characters:overlap,...(table?{table}:{}),provenance:{...scope},permission_source:{type:'current_document_acl',tenant_id:scope.tenant_id,kb_id:scope.kb_id,document_id:scope.document_id}});
 };
 if(strategy==='fixed-window-v1'){
  // Evaluation baseline only: flatten all blocks, preserving intersecting source ranges.
  const segments:Array<{block:ParsedBlock;start:number;end:number}>=[];let text='';
  for(const b of parsed.blocks){await check();if(text)text+='\n\n';const start=text.length;text+=b.text;segments.push({block:b,start,end:text.length})}
  let start=0,previousEnd=0;while(start<text.length){const end=boundary(text,Math.min(text.length,start+MAX)),selected=segments.filter(s=>s.end>start&&s.start<end),spans=selected.map(s=>span(s.block,Math.max(0,start-s.start),Math.min(s.block.text.length,end-s.start)));if(selected.some(s=>s.block.kind==='table'&&(start>s.start||end<s.end)))warn('FIXED_WINDOW_SPLITS_TABLE');await emit(text.slice(start,end),spans,selected[0]?.block.heading_path??[],'text',Math.max(0,previousEnd-start));if(end===text.length)break;previousEnd=end;start=startAt(text,end-OVERLAP)}
 }else{
  let pending='',pendingSpans:ChunkSpan[]=[],path:string[]=[];
  const flush=async()=>{if(pending)await emit(pending,pendingSpans,path);pending='';pendingSpans=[]};
  for(const b of parsed.blocks){await check();
   if(b.kind==='header'||b.kind==='footer'){excluded++;continue}
   if(b.kind==='heading'||JSON.stringify(path)!==JSON.stringify(b.heading_path)){await flush();path=[...b.heading_path]}
   const context=prefix(b.heading_path),budget=MAX-(context?context.length+2:0);if(b.heading_path.join(' / ').length>CONTEXT)warn('CHUNK_HEADING_CONTEXT_TRUNCATED',b);
   if(b.kind==='table'&&b.table){
    await flush();const rows=b.table.rows.map(row=>row.map(cell=>cell.text).join('\t'));if(rows.join('\n')!==b.text)fail('CHUNK_INVALID_TABLE');const h=b.table.header_rows;
    if(!Number.isInteger(h)||h<0||h>rows.length)fail('CHUNK_INVALID_TABLE');if(!h)warn('CHUNK_TABLE_HEADER_UNKNOWN',b);if(b.table.rows.some(r=>r.some(c=>c.v_merge||c.col_span>1)))warn('CHUNK_MERGED_TABLE_REVIEW',b);
    const offsets:number[]=[];let offset=0;for(const row of rows){offsets.push(offset);offset+=row.length+1}
    const header=rows.slice(0,h).join('\n'),headerEnd=h?offsets[h-1]!+rows[h-1]!.length:0;let first=true;
    if(header.length>budget)fail('CHUNK_TABLE_HEADER_TOO_LARGE');
    if(h===rows.length){await emit(header,[{...span(b,0,headerEnd),role:'table_header',row_start:0,row_end:h}],b.heading_path,'table',0,{header_rows:h,rows:b.table.rows,row_start:h,row_end:h});continue}
    for(let begin=h;begin<rows.length;){await check();let end=begin,body=header;
     while(end<rows.length){const next=body?`${body}\n${rows[end]!}`:rows[end]!;if(next.length>budget)break;body=next;end++}
     if(end===begin)fail('CHUNK_TABLE_ROW_TOO_LARGE');
     const refs:ChunkSpan[]=[];if(h)refs.push({...span(b,0,headerEnd),role:'table_header',row_start:0,row_end:h});refs.push({...span(b,offsets[begin]!,offsets[end-1]!+rows[end-1]!.length),row_start:begin,row_end:end});
     await emit(body,refs,b.heading_path,'table',0,{header_rows:h,rows:[...b.table.rows.slice(0,h),...b.table.rows.slice(begin,end)],row_start:begin,row_end:end});if(!first)repeatedHeaders+=header.length;first=false;begin=end;
    }continue;
   }
   if(b.kind==='code')await flush();
   if(b.text.length>budget){await flush();let start=0,previousEnd=0;while(start<b.text.length){const end=endAt(b.text,start,budget);if(end<=start)fail('CHUNK_LENGTH_LIMIT');await emit(b.text.slice(start,end),[span(b,start,end)],b.heading_path,b.kind==='code'?'code':'text',Math.max(0,previousEnd-start));if(end===b.text.length)break;previousEnd=end;start=startAt(b.text,Math.max(start+1,end-OVERLAP))}continue}
   if(b.kind==='code'){await emit(b.text,[span(b)],b.heading_path,'code');continue}
   if(pending&&pending.length+2+b.text.length>budget)await flush();pending+=(pending?'\n\n':'')+b.text;pendingSpans.push(span(b));
  }await flush();
 }
 if(!chunks.length)fail('CHUNK_NO_CONTENT');
 const duplicate=chunks.length-new Set(chunks.map(c=>hash(c.text.normalize('NFC').replace(/\s+/gu,' ').trim()))).size;
 const result:ChunkSet={chunker_version:CHUNKER_VERSION,scope:{...scope},policy:{strategy,max_characters:MAX,overlap_characters:OVERLAP,heading_context_characters:strategy==='structure-v1'?CONTEXT:0,offset_unit:'utf16'},chunks,warnings,source_warnings:parsed.warnings,metrics:{chunks:chunks.length,exact_duplicate_chunks:duplicate,duplicate_ratio:duplicate/chunks.length,overlap_characters:chunks.reduce((n,c)=>n+c.overlap_characters,0),repeated_table_header_characters:repeatedHeaders,retrieval_characters:chunks.reduce((n,c)=>n+c.retrieval_text.length,0),max_chunk_characters:Math.max(...chunks.map(c=>c.retrieval_text.length)),excluded_header_footer_blocks:excluded}};
 if(Buffer.byteLength(JSON.stringify(result))>MAX_OUTPUT)fail('CHUNK_OUTPUT_LIMIT');return result;
}
