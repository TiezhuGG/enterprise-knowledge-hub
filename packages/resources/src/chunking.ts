import { createHmac,timingSafeEqual } from 'node:crypto';
import { buildChunks,CHUNKER_VERSION,ChunkFailure } from '@zhiheng/chunker';
import { STRUCTURE_PARSER_VERSION,type ChunkSet,type ChunkPreview,type ChunkScope,type IdentityContext,type KnowledgeChunk } from '@zhiheng/contracts';
import { ParsingStore } from './parsing';
import { transaction } from './database';
import { fail } from './policy';
import { sha256 } from './objects';
import type { AttemptLease } from './ingestion';
export class ChunkingStore extends ParsingStore {
 async resumeParsed(lease:AttemptLease,continueChunking:boolean):Promise<'missing'|'ready'|'closed'>{return transaction(this.pool,async client=>{
  const row=await this.parsingLease(client,lease);if(!row)return 'closed';const found=await client.query('SELECT 1 FROM parsed_document WHERE tenant_id=$1 AND version_id=$2 AND parser_version=$3',[row.tenant_id,row.version_id,row.parser_version]);if(!found.rowCount)return 'missing';
  if(continueChunking)return 'ready';await this.endAttempt(client,row,'completed',null);await this.change(client,row,{status:'waiting_dependency',stage:'awaiting_chunker',error_code:'CHUNKER_NOT_CONFIGURED',dead_letter:false});return 'closed';
 });}
 resumeWaitingChunkers(){return transaction(this.pool,async client=>{
  const rows=await client.query("SELECT * FROM ingestion_job j WHERE status='waiting_dependency' AND stage='awaiting_chunker' AND error_code='CHUNKER_NOT_CONFIGURED' AND cancel_requested_at IS NULL AND EXISTS(SELECT 1 FROM parsed_document p WHERE p.tenant_id=j.tenant_id AND p.version_id=j.version_id AND p.parser_version=j.parser_version) LIMIT 100 FOR UPDATE SKIP LOCKED");
  for(const row of rows.rows)await this.change(client,row,{status:'queued',stage:'queued',run_no:row.run_no+1,attempt_count:0,error_code:null,dead_letter:false,next_run_at:new Date(),last_enqueued_at:null,dispatch_revision:row.dispatch_revision+1});return rows.rowCount??0;
 });}
 async chunkLease(lease:AttemptLease,signal?:AbortSignal,continueIndexing=false){
  const input=await transaction(this.pool,async client=>{
   const row=await this.parsingLease(client,lease);if(!row)return null;if(row.chunker_version!==CHUNKER_VERSION){await this.failed(client,row,'CHUNK_VERSION_UNSUPPORTED',false);return null}
   const parsed=(await client.query('SELECT p.*,v.version_no,v.source_asset_id FROM parsed_document p JOIN document_version v ON v.tenant_id=p.tenant_id AND v.id=p.version_id WHERE p.tenant_id=$1 AND p.version_id=$2 AND p.parser_version=$3',[row.tenant_id,row.version_id,row.parser_version])).rows[0];if(!parsed)fail(409,'PARSED_OUTPUT_NOT_READY');
   await this.change(client,row,{status:'running',stage:'chunking',error_code:null});const scope:ChunkScope={tenant_id:row.tenant_id,kb_id:row.kb_id,document_id:row.document_id,version_id:row.version_id,version_no:parsed.version_no,source_asset_id:parsed.source_asset_id,source_sha256:row.source_sha256,parser_version:row.parser_version,parsed_artifact_sha256:parsed.artifact_sha256};return {parsed,scope};
  });if(!input)return false;
  const parsed=await this.readParsedArtifact(input.parsed,signal),result=await buildChunks(parsed,input.scope,'structure-v1',signal);if(signal?.aborted)throw new ChunkFailure('CHUNK_CANCELLED');
  const bytes=Buffer.from(JSON.stringify(result)),digest=sha256(bytes),key=`tenants/${lease.tenant_id}/chunks/${input.scope.version_id}/${CHUNKER_VERSION}/${digest}`;
  const objectVersion=await this.trackedWrite(lease.tenant_id,input.scope.document_id,lease.job_id,'chunks',()=>this.objects.put(key,bytes,'application/json'),c=>this.parsingLease(c,lease));
  return transaction(this.pool,async client=>{
   const row=await this.parsingLease(client,lease);if(!row)return false;if(row.chunker_version!==CHUNKER_VERSION)fail(422,'CHUNK_VERSION_UNSUPPORTED');
   const old=(await client.query('SELECT artifact_sha256 FROM chunk_manifest WHERE tenant_id=$1 AND version_id=$2 AND parser_version=$3 AND chunker_version=$4',[row.tenant_id,row.version_id,row.parser_version,CHUNKER_VERSION])).rows[0];
   if(old&&old.artifact_sha256!==digest){await this.failed(client,row,'CHUNK_RESULT_MISMATCH',false);return false}
   if(!old){
    await client.query('INSERT INTO chunk_manifest(tenant_id,kb_id,document_id,version_id,parser_version,chunker_version,source_sha256,parsed_artifact_sha256,artifact_sha256,object_key,object_version,artifact_size,chunk_count,policy,metrics,warnings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[row.tenant_id,row.kb_id,row.document_id,row.version_id,row.parser_version,CHUNKER_VERSION,row.source_sha256,input.scope.parsed_artifact_sha256,digest,key,objectVersion,bytes.length,result.chunks.length,JSON.stringify(result.policy),JSON.stringify(result.metrics),JSON.stringify(result.warnings)]);
    await client.query(`INSERT INTO knowledge_chunk(tenant_id,version_id,parser_version,chunker_version,ordinal,id,kind,text_sha256,retrieval_sha256,text_length,retrieval_length,heading_path) SELECT $1,$2,$3,$4,c.ordinal,c.id,c.kind,c.text_sha256,c.retrieval_sha256,c.text_length,c.retrieval_length,c.heading_path FROM jsonb_to_recordset($5::jsonb) AS c(ordinal integer,id uuid,kind text,text_sha256 text,retrieval_sha256 text,text_length integer,retrieval_length integer,heading_path text[])`,[row.tenant_id,row.version_id,row.parser_version,CHUNKER_VERSION,JSON.stringify(result.chunks.map(c=>({ordinal:c.ordinal,id:c.id,kind:c.kind,text_sha256:c.text_sha256,retrieval_sha256:c.retrieval_sha256,text_length:c.text.length,retrieval_length:c.retrieval_text.length,heading_path:c.heading_path})))]);
    await client.query(`INSERT INTO chunk_source(tenant_id,version_id,parser_version,chunker_version,chunk_ordinal,span_ordinal,block_id,start_offset,end_offset,role,source,row_start,row_end) SELECT $1,$2,$3,$4,s.chunk_ordinal,s.span_ordinal,s.block_id,s.start_offset,s.end_offset,s.role,s.source,s.row_start,s.row_end FROM jsonb_to_recordset($5::jsonb) AS s(chunk_ordinal integer,span_ordinal integer,block_id uuid,start_offset integer,end_offset integer,role text,source jsonb,row_start integer,row_end integer)`,[row.tenant_id,row.version_id,row.parser_version,CHUNKER_VERSION,JSON.stringify(result.chunks.flatMap(c=>c.spans.map((s,i)=>({...s,chunk_ordinal:c.ordinal,span_ordinal:i,start_offset:s.start,end_offset:s.end}))))]);
   }
   await client.query("INSERT INTO ingestion_checkpoint(tenant_id,job_id,step,input_sha256,processor_version) VALUES($1,$2,'chunk_structure',$3,$4) ON CONFLICT DO NOTHING",[row.tenant_id,row.id,input.scope.parsed_artifact_sha256,CHUNKER_VERSION]);if(continueIndexing){await this.change(client,row,{status:'running',stage:'indexing',error_code:null});return true}await this.endAttempt(client,row,'completed',null);await this.change(client,row,{status:'waiting_dependency',stage:'awaiting_indexer',error_code:'INDEXER_NOT_CONFIGURED',dead_letter:false});return true;
  });
 }
 protected async readChunks(row:any,signal?:AbortSignal):Promise<ChunkSet>{
  const bytes=await this.objects.read(row.object_key,row.object_version,row.artifact_size,signal);if(sha256(bytes)!==row.artifact_sha256)fail(422,'CHUNK_ARTIFACT_MISMATCH');let result:ChunkSet;try{result=JSON.parse(bytes.toString('utf8'))}catch{fail(422,'CHUNK_ARTIFACT_MISMATCH')}
  if(result.chunker_version!==CHUNKER_VERSION||result.scope?.version_id!==row.version_id||result.scope?.document_id!==row.document_id||result.scope?.tenant_id!==row.tenant_id||result.scope?.source_sha256!==row.source_sha256||result.scope?.parsed_artifact_sha256!==row.parsed_artifact_sha256||!Array.isArray(result.chunks)||result.chunks.length!==row.chunk_count)fail(422,'CHUNK_ARTIFACT_MISMATCH');return result;
 }
 listChunks(current:IdentityContext,doc:string,versionId:string,input:{limit:number;cursor?:string}):Promise<ChunkPreview>{return this.run(current,async(client,member)=>{
  await this.version(client,member,doc,versionId);const row=(await client.query('SELECT * FROM chunk_manifest WHERE tenant_id=$1 AND document_id=$2 AND version_id=$3 AND parser_version=$4 AND chunker_version=$5',[member.tenant_id,doc,versionId,STRUCTURE_PARSER_VERSION,CHUNKER_VERSION])).rows[0];if(!row)fail(409,'CHUNKS_NOT_READY');if(this.cursorSecret.length<32)fail(503,'CURSOR_SECRET_REQUIRED');
  const scope=sha256(Buffer.from(JSON.stringify([member.tenant_id,member.membership_id,member.authz_version,member.role,doc,versionId,CHUNKER_VERSION,input.limit])));let after=-1;
  if(input.cursor){try{const [payload,signature,extra]=input.cursor.split('.');if(!payload||!signature||extra)throw new Error();const expected=createHmac('sha256',this.cursorSecret).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();const decoded=JSON.parse(Buffer.from(payload,'base64url').toString());if(decoded.scope!==scope||!Number.isInteger(decoded.after)||decoded.after<0)throw new Error();after=decoded.after}catch{fail(400,'INVALID_CURSOR')}}
  const result=await this.readChunks(row),selected=result.chunks.filter(c=>c.ordinal>after),chunks=selected.slice(0,input.limit),more=selected.length>input.limit;let cursor:string|null=null;
  if(more){const payload=Buffer.from(JSON.stringify({scope,after:chunks.at(-1)!.ordinal})).toString('base64url');cursor=`${payload}.${createHmac('sha256',this.cursorSecret).update(payload).digest('base64url')}`}
  return {document_id:doc,version_id:versionId,result:{...result,chunks},total_chunks:row.chunk_count,page:{next_cursor:cursor,has_more:more}};
 });}
 getChunk(current:IdentityContext,doc:string,versionId:string,chunkId:string):Promise<KnowledgeChunk>{return this.run(current,async(client,member)=>{
  await this.version(client,member,doc,versionId);const row=(await client.query('SELECT m.* FROM chunk_manifest m JOIN knowledge_chunk c ON c.tenant_id=m.tenant_id AND c.version_id=m.version_id AND c.parser_version=m.parser_version AND c.chunker_version=m.chunker_version WHERE m.tenant_id=$1 AND m.document_id=$2 AND m.version_id=$3 AND c.id=$4 AND m.chunker_version=$5',[member.tenant_id,doc,versionId,chunkId,CHUNKER_VERSION])).rows[0];if(!row)fail(404,'RESOURCE_UNAVAILABLE');const chunk=(await this.readChunks(row)).chunks.find(c=>c.id===chunkId);if(!chunk)fail(422,'CHUNK_ARTIFACT_MISMATCH');return chunk;
 });}
}
