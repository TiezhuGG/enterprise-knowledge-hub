import { createHmac,timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { STRUCTURE_PARSER_VERSION,type ParsedDocument,type ParsedPreview,type IdentityContext } from '@zhiheng/contracts';
import { IngestionStore,type AttemptLease } from './ingestion';
import { transaction } from './database';
import { ResourceError,fail } from './policy';
import { sha256 } from './objects';
const kinds=new Set(['heading','paragraph','list_item','table','code','header','footer']);
function blockId(version:string,ordinal:number){const bytes=Buffer.from(sha256(Buffer.from(`${version}:${STRUCTURE_PARSER_VERSION}:${ordinal}`)).slice(0,32),'hex');bytes[6]=(bytes[6]!&15)|128;bytes[8]=(bytes[8]!&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
function validate(result:ParsedDocument){
 if(result.parser_version!==STRUCTURE_PARSER_VERSION||!['txt','markdown','pdf','docx'].includes(result.format)||!Array.isArray(result.blocks)||!result.blocks.length||result.blocks.length>50000||!Array.isArray(result.warnings)||result.warnings.length>5000||!result.metrics||!Number.isInteger(result.metrics.characters)||result.metrics.characters<1)fail(422,'PARSER_INVALID_RESULT');
 for(let i=0;i<result.blocks.length;i++){const b=result.blocks[i]!;if(b.ordinal!==i||!kinds.has(b.kind)||typeof b.text!=='string'||!Array.isArray(b.heading_path)||b.heading_path.length>9||b.heading_path.some(v=>typeof v!=='string'||v.length>200)||!b.source||!['text','pdf','docx'].includes(b.source.type))fail(422,'PARSER_INVALID_RESULT');
  if(b.source.type==='text'&&(!Number.isInteger(b.source.char_start)||!Number.isInteger(b.source.char_end)||b.source.char_start!<0||b.source.char_end!<b.source.char_start!))fail(422,'PARSER_INVALID_RESULT');
  if(b.source.type==='pdf'&&(!Number.isInteger(b.source.page)||b.source.page!<1||!Array.isArray(b.source.bbox)||b.source.bbox.length!==4||!b.source.bbox.every(Number.isFinite)))fail(422,'PARSER_INVALID_RESULT');
  if(b.table&&(!Array.isArray(b.table.rows)||!b.table.rows.length||b.table.rows.some(row=>!Array.isArray(row)||row.some(cell=>typeof cell.text!=='string'||!Number.isInteger(cell.col_span)||cell.col_span<1||cell.col_span>100))))fail(422,'PARSER_INVALID_RESULT');
 }
}
export class ParsingStore extends IngestionStore {
 protected async parsingLease(client:PoolClient,lease:AttemptLease){
  const initial=(await client.query('SELECT * FROM ingestion_job WHERE tenant_id=$1 AND id=$2',[lease.tenant_id,lease.job_id])).rows[0];if(!initial)return null;
  let denied=false;try{await this.executor(client,initial)}catch(error){if(error instanceof ResourceError&&[401,404].includes(error.status))denied=true;else throw error}
  const row=await this.owned(client,lease);if(!row)return null;
  if(row.cancel_requested_at){await this.failed(client,row,'USER_CANCELLED',false);return null}if(denied){await this.failed(client,row,'ACCESS_REVOKED',false);return null}
  if(row.deadline_at.getTime()<=row.db_now.getTime()){await this.failed(client,row,'WORKER_DEADLINE',true);return null}
  const source=(await client.query('SELECT a.scan_status,v.content_sha256 FROM document_version v JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id WHERE v.tenant_id=$1 AND v.id=$2 FOR SHARE OF a',[row.tenant_id,row.version_id])).rows[0];
  if(!source||source.scan_status==='rejected'){await this.failed(client,row,'SOURCE_REJECTED',false);return null}if(row.parser_version!==STRUCTURE_PARSER_VERSION){await this.failed(client,row,'PARSER_VERSION_UNSUPPORTED',false);return null}
  return {...row,source_sha256:source.content_sha256};
 }
 async completeParsing(lease:AttemptLease,input:ParsedDocument,continueChunking=false){
  validate(input);const first=await transaction(this.pool,client=>this.parsingLease(client,lease));if(!first)return false;
  if(input.source_sha256!==first.source_sha256)fail(422,'PARSER_INVALID_RESULT');
  const result:ParsedDocument={...input,blocks:input.blocks.map(block=>({...block,id:blockId(first.version_id,block.ordinal)}))};
  const bytes=Buffer.from(JSON.stringify(result));if(bytes.length>20971520)fail(422,'PARSE_OUTPUT_LIMIT');const digest=sha256(bytes),key=`tenants/${lease.tenant_id}/parsed/${first.version_id}/${STRUCTURE_PARSER_VERSION}/${digest}`;
  const version=await this.objects.put(key,bytes,'application/json');
  return transaction(this.pool,async client=>{
   const row=await this.parsingLease(client,lease);if(!row)return false;
   const old=(await client.query('SELECT artifact_sha256 FROM parsed_document WHERE tenant_id=$1 AND version_id=$2 AND parser_version=$3',[row.tenant_id,row.version_id,STRUCTURE_PARSER_VERSION])).rows[0];
   if(old&&old.artifact_sha256!==digest){await this.failed(client,row,'PARSER_RESULT_MISMATCH',false);return false}
   if(!old){
    await client.query('INSERT INTO parsed_document(tenant_id,document_id,version_id,parser_version,source_sha256,artifact_sha256,object_key,object_version,artifact_size,format,page_count,block_count,warnings,metrics) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[row.tenant_id,row.document_id,row.version_id,STRUCTURE_PARSER_VERSION,row.source_sha256,digest,key,version,bytes.length,result.format,result.page_count,result.blocks.length,JSON.stringify(result.warnings),JSON.stringify(result.metrics)]);
    await client.query(`INSERT INTO parsed_block(tenant_id,version_id,parser_version,ordinal,id,kind,heading_path,source,text_sha256,text_length) SELECT $1,$2,$3,b.ordinal,b.id,b.kind,b.heading_path,b.source,b.text_sha256,b.text_length FROM jsonb_to_recordset($4::jsonb) AS b(ordinal integer,id uuid,kind text,heading_path text[],source jsonb,text_sha256 text,text_length integer)`,[row.tenant_id,row.version_id,STRUCTURE_PARSER_VERSION,JSON.stringify(result.blocks.map(b=>({ordinal:b.ordinal,id:b.id,kind:b.kind,heading_path:b.heading_path,source:b.source,text_sha256:sha256(Buffer.from(b.text)),text_length:b.text.length})))]);
   }
   await client.query("INSERT INTO ingestion_checkpoint(tenant_id,job_id,step,input_sha256,processor_version) VALUES($1,$2,'parse_structure',$3,$4) ON CONFLICT DO NOTHING",[row.tenant_id,row.id,row.source_sha256,STRUCTURE_PARSER_VERSION]);
   if(continueChunking){await this.change(client,row,{status:'running',stage:'chunking',error_code:null});return true}
   await this.endAttempt(client,row,'completed',null);await this.change(client,row,{status:'waiting_dependency',stage:'awaiting_chunker',error_code:'CHUNKER_NOT_CONFIGURED',dead_letter:false});return true;
  });
 }
 protected async readParsedArtifact(row:any,signal?:AbortSignal):Promise<ParsedDocument>{
  const bytes=await this.objects.read(row.object_key,row.object_version,row.artifact_size,signal);if(sha256(bytes)!==row.artifact_sha256)fail(422,'PARSED_ARTIFACT_MISMATCH');let result:ParsedDocument;try{result=JSON.parse(bytes.toString('utf8'))}catch{fail(422,'PARSED_ARTIFACT_MISMATCH')}
  validate(result);if(result.source_sha256!==row.source_sha256)fail(422,'PARSED_ARTIFACT_MISMATCH');
  return result;
 }
 resumeWaitingParsers(){return transaction(this.pool,async client=>{
  const rows=await client.query("SELECT * FROM ingestion_job WHERE status='waiting_dependency' AND stage='awaiting_parser' AND error_code='PARSER_NOT_CONFIGURED' AND cancel_requested_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED");
  for(const row of rows.rows)await this.change(client,row,{status:'queued',stage:'queued',run_no:row.run_no+1,attempt_count:0,error_code:null,dead_letter:false,next_run_at:new Date(),last_enqueued_at:null,dispatch_revision:row.dispatch_revision+1});return rows.rowCount??0;
 });}
 getParsed(current:IdentityContext,doc:string,versionId:string,input:{limit:number;cursor?:string;page?:number;block_id?:string}):Promise<ParsedPreview>{return this.run(current,async(client,member)=>{
  await this.version(client,member,doc,versionId);
  const row=(await client.query('SELECT * FROM parsed_document WHERE tenant_id=$1 AND document_id=$2 AND version_id=$3 AND parser_version=$4',[member.tenant_id,doc,versionId,STRUCTURE_PARSER_VERSION])).rows[0];if(!row)fail(409,'PARSED_OUTPUT_NOT_READY');
  if(input.page!==undefined&&(row.format!=='pdf'||input.page>row.page_count))fail(400,'INVALID_PAGE');if(this.cursorSecret.length<32)fail(503,'CURSOR_SECRET_REQUIRED');
  const scope=sha256(Buffer.from(JSON.stringify([member.tenant_id,member.membership_id,member.authz_version,member.role,doc,versionId,STRUCTURE_PARSER_VERSION,input.limit,input.page??null,input.block_id??null])));let after=-1;
  if(input.cursor){try{const [payload,signature,extra]=input.cursor.split('.');if(!payload||!signature||extra)throw new Error();const expected=createHmac('sha256',this.cursorSecret).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();const decoded=JSON.parse(Buffer.from(payload,'base64url').toString());if(decoded.scope!==scope||!Number.isInteger(decoded.after)||decoded.after<0)throw new Error();after=decoded.after}catch{fail(400,'INVALID_CURSOR')}}
  const result=await this.readParsedArtifact(row);
  if(input.block_id&&!result.blocks.some(b=>b.id===input.block_id))fail(404,'RESOURCE_UNAVAILABLE');
  const selected=result.blocks.filter(b=>b.ordinal>after&&(input.page===undefined||b.source.page===input.page)&&(!input.block_id||b.id===input.block_id)),blocks=selected.slice(0,input.limit),more=selected.length>input.limit;let cursor:string|null=null;
  if(more){const payload=Buffer.from(JSON.stringify({scope,after:blocks.at(-1)!.ordinal})).toString('base64url');cursor=`${payload}.${createHmac('sha256',this.cursorSecret).update(payload).digest('base64url')}`}
  return {document_id:doc,version_id:versionId,result:{...result,blocks},total_blocks:row.block_count,page:{next_cursor:cursor,has_more:more}};
 });}
}
