import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext, IngestionJob, IngestionDetails, IngestionDelivery } from '@zhiheng/contracts';
import { transaction } from './database';
import { UploadStore } from './uploads';
import { kbCaps, docCaps, type ListInput } from './store';
import { ROLE_ACTIONS, ResourceError, fail } from './policy';
import { sha256, type ObjectStore } from './objects';
import type { UploadLimits } from './upload-validation';
import { ingestionConfig, type IngestionConfig } from './job-contract';
export interface AttemptLease {tenant_id:string;job_id:string;run_no:number;lease_token:string;source:{key:string;version:string;size:number;sha256:string;mime:string;filename:string};checkpoint:boolean;parser_version:string}
const terminal=new Set(['succeeded','failed','cancelled']);
const manualRetry=new Set(['SOURCE_UNAVAILABLE','LEASE_EXPIRED','WORKER_DEADLINE','WORKER_ERROR','ACCESS_REVOKED','PARSE_TIMEOUT','PARSE_RESOURCE_LIMIT','PARSER_START_FAILED','PARSER_FAILED','CHUNK_TIMEOUT']);
export class IngestionStore extends UploadStore {
  constructor(url:string|undefined,schema:string|undefined,secret:string|undefined,objects:ObjectStore,limits:UploadLimits,readonly config:IngestionConfig=ingestionConfig()){super(url,schema,secret,objects,limits)}
  private view(row:any):IngestionJob{return {id:row.id,kb_id:row.kb_id,document_id:row.document_id,version_id:row.version_id,version_no:row.version_no,pipeline_version:row.pipeline_version,status:row.status,stage:row.stage,error_code:row.error_code,dead_letter:row.dead_letter,run_no:row.run_no,attempt_count:row.attempt_count,total_attempts:row.total_attempts,max_attempts:row.max_attempts,progress:null,next_run_at:['queued','retry_wait'].includes(row.status)?row.next_run_at.toISOString():null,cancel_requested:!!row.cancel_requested_at,created_at:row.created_at.toISOString(),updated_at:row.updated_at.toISOString()}}
  protected async change(client:PoolClient,row:any,patch:Record<string,unknown>){
    if(patch.status&&patch.status!=='running')Object.assign(patch,{lease_token:null,worker_id:null,lease_until:null,deadline_at:null});
    const entries=Object.entries(patch);const result=await client.query(`UPDATE ingestion_job SET ${entries.map(([column],i)=>`${column}=$${i+3}`).join(',')},updated_at=now(),event_seq=event_seq+1 WHERE tenant_id=$1 AND id=$2 RETURNING *`,[row.tenant_id,row.id,...entries.map(([,value])=>value)]);
    const updated=result.rows[0];await client.query('INSERT INTO ingestion_event(tenant_id,job_id,seq,run_no,status,stage,error_code) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.tenant_id,row.id,updated.event_seq,updated.run_no,updated.status,updated.stage,updated.error_code]);return {...updated,version_no:row.version_no};
  }
  private async access(client:PoolClient,current:IdentityContext,id:string,action?:'retry'|'cancel'){
    const result=await client.query('SELECT j.*,(SELECT version_no FROM document_version v WHERE v.tenant_id=j.tenant_id AND v.id=j.version_id) AS version_no FROM ingestion_job j WHERE j.tenant_id=$1 AND j.id=$2',[current.tenant_id,id]);const row=result.rows[0];if(!row)fail(404,'RESOURCE_UNAVAILABLE');
    const doc=await this.doc(client,current,row.document_id,'read');
    if(row.owner_id!==current.membership_id)await this.kb(client,current,row.kb_id,'manage');
    if(action==='retry'&&!doc.capabilities.includes('write'))fail(404,'RESOURCE_UNAVAILABLE');
    if(action==='cancel'&&!doc.capabilities.some(cap=>['write','manage'].includes(cap)))fail(404,'RESOURCE_UNAVAILABLE');
    if(!action)return row;
    return (await client.query('SELECT j.*,(SELECT version_no FROM document_version v WHERE v.tenant_id=j.tenant_id AND v.id=j.version_id) AS version_no FROM ingestion_job j WHERE j.tenant_id=$1 AND j.id=$2 FOR UPDATE OF j',[current.tenant_id,id])).rows[0];
  }
  getJob(current:IdentityContext,id:string){return this.run(current,async(client,member):Promise<IngestionDetails>=>{
    const row=await this.access(client,member,id);const attempts=await client.query('SELECT run_no,attempt_no,status,error_code,started_at,ended_at FROM ingestion_attempt WHERE tenant_id=$1 AND job_id=$2 ORDER BY run_no DESC,attempt_no DESC LIMIT 20',[member.tenant_id,id]);const events=await client.query('SELECT seq,run_no,status,stage,error_code,occurred_at FROM ingestion_event WHERE tenant_id=$1 AND job_id=$2 ORDER BY seq DESC LIMIT 20',[member.tenant_id,id]);
    return {...this.view(row),attempts:attempts.rows.reverse().map(a=>({...a,started_at:a.started_at.toISOString(),ended_at:a.ended_at?.toISOString()??null})),events:events.rows.reverse().map(e=>({...e,occurred_at:e.occurred_at.toISOString()}))};
  });}
  listJobs(current:IdentityContext,input:ListInput&{kb_id?:string;document_id?:string}){return this.run(current,async(client,member)=>{
    const scope=this.scope(member,input,`jobs:${input.kb_id??''}:${input.document_id??''}`),after=this.cursor(input,scope);
    const result=await client.query(`SELECT * FROM (SELECT *,CASE WHEN acl_mode='inherit' THEN kb_caps ELSE ARRAY(SELECT unnest(kb_caps) INTERSECT SELECT unnest(doc_caps)) END AS effective_caps FROM (SELECT j.*,v.version_no,d.status AS document_status,d.acl_mode,k.status AS kb_status,${kbCaps} AS kb_caps,${docCaps} AS doc_caps FROM ingestion_job j JOIN document_version v ON v.tenant_id=j.tenant_id AND v.id=j.version_id JOIN document d ON d.tenant_id=j.tenant_id AND d.id=j.document_id JOIN knowledge_base k ON k.tenant_id=j.tenant_id AND k.id=j.kb_id WHERE j.tenant_id=$1) raw) visible
      WHERE (owner_id=$2 OR 'manage'=ANY(kb_caps)) AND 'read'=ANY(effective_caps) AND kb_status='active' AND document_status<>'deleted'
      AND (document_status='active' OR effective_caps && ARRAY['write','publish','manage']::text[])
      AND ($4::text IS NULL OR status=$4) AND ($5::uuid IS NULL OR kb_id=$5) AND ($6::uuid IS NULL OR document_id=$6)
      AND ($7::timestamptz IS NULL OR (created_at,id)<($7,$8::uuid)) ORDER BY created_at DESC,id DESC LIMIT $9`,[member.tenant_id,member.membership_id,ROLE_ACTIONS[member.role],input.status??null,input.kb_id??null,input.document_id??null,after?.[0]??null,after?.[1]??null,input.limit+1]);
    return this.page(result.rows.map(row=>this.view(row)),input,scope);
  });}
  operateJob(current:IdentityContext,id:string,action:'retry'|'cancel',key:string,payloadHash:string,requestId:string){return this.run(current,async(client,member)=>{
    const row=await this.access(client,member,id,action);const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now;const keyHash=sha256(Buffer.from(key));
    const old=await client.query('SELECT payload_hash FROM ingestion_operation WHERE tenant_id=$1 AND job_id=$2 AND member_id=$3 AND action=$4 AND key_hash=$5',[member.tenant_id,id,member.membership_id,action,keyHash]);
    if(old.rowCount){if(old.rows[0].payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_KEY_REUSED');return this.view(row)}
    let updated=row;
    if(action==='retry'){
      if(row.status!=='failed'||!manualRetry.has(row.error_code))fail(409,'JOB_NOT_RETRYABLE');
      updated=await this.change(client,row,{status:'queued',stage:'queued',run_no:row.run_no+1,attempt_count:0,executor_id:member.membership_id,dispatch_revision:row.dispatch_revision+1,last_enqueued_at:null,next_run_at:now,cancel_requested_at:null,error_code:null,dead_letter:false});
      await client.query('UPDATE ingestion_dead_letter SET resolved_at=now() WHERE tenant_id=$1 AND job_id=$2 AND run_no=$3',[member.tenant_id,id,row.run_no]);
    }else if(!terminal.has(row.status)&&!row.cancel_requested_at){
      updated=await this.change(client,row,row.status==='running'?{cancel_requested_at:now,stage:'cancel_requested'}:{status:'cancelled',stage:'cancelled',cancel_requested_at:now,error_code:'USER_CANCELLED',dead_letter:false});
    }
    await client.query('INSERT INTO ingestion_operation(tenant_id,job_id,member_id,action,key_hash,payload_hash,run_no) VALUES($1,$2,$3,$4,$5,$6,$7)',[member.tenant_id,id,member.membership_id,action,keyHash,payloadHash,updated.run_no]);
    await this.audit(client,member,id,`ingestion.${action}`,requestId);return this.view(updated);
  });}
  protected async executor(client:PoolClient,row:any){
    const result=await client.query('SELECT actor_id FROM membership WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.executor_id]);if(!result.rows[0])fail(401,'MEMBERSHIP_INACTIVE');
    const current=await this.member(client,{actor_id:result.rows[0].actor_id,tenant_id:row.tenant_id,membership_id:row.executor_id,role:'employee',capabilities:[],provider:'development'});
    await this.doc(client,current,row.document_id,'write');return current;
  }
  protected async endAttempt(client:PoolClient,row:any,status:string,code:string|null){await client.query('UPDATE ingestion_attempt SET status=$4,error_code=$5,ended_at=now() WHERE tenant_id=$1 AND job_id=$2 AND lease_token=$3 AND status=\'running\'',[row.tenant_id,row.id,row.lease_token,status,code])}
  protected async failed(client:PoolClient,row:any,code:string,automatic:boolean,interrupted=false){
    if(row.cancel_requested_at){await this.endAttempt(client,row,'cancelled','USER_CANCELLED');await this.change(client,row,{status:'cancelled',stage:'cancelled',error_code:'USER_CANCELLED',dead_letter:false});return}
    const retry=automatic&&row.attempt_count<row.max_attempts;
    await this.endAttempt(client,row,interrupted?'interrupted':'failed',code);
    const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    const jitter=Math.floor(Math.random()*Math.min(250,this.config.retryMs));
    await this.change(client,row,{status:retry?'retry_wait':'failed',stage:retry?'retry_wait':'failed',error_code:code,dead_letter:!retry,next_run_at:new Date(now+Math.min(60000,this.config.retryMs*2**Math.max(0,row.attempt_count-1))+jitter),last_enqueued_at:null});
    if(!retry)await client.query('INSERT INTO ingestion_dead_letter(tenant_id,job_id,run_no,error_code) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[row.tenant_id,row.id,row.run_no,code]);
  }
  claim(delivery:IngestionDelivery,workerId:string){return transaction(this.pool,async(client):Promise<AttemptLease|null>=>{
    let row=(await client.query('SELECT j.*,(SELECT version_no FROM document_version v WHERE v.tenant_id=j.tenant_id AND v.id=j.version_id) AS version_no FROM ingestion_job j WHERE j.tenant_id=$1 AND j.id=$2',[delivery.tenant_id,delivery.job_id])).rows[0];if(!row)return null;
    let denied=false;try{await this.executor(client,row)}catch(error){if(error instanceof ResourceError&&[401,404].includes(error.status))denied=true;else throw error}
    row=(await client.query('SELECT j.*,(SELECT version_no FROM document_version v WHERE v.tenant_id=j.tenant_id AND v.id=j.version_id) AS version_no FROM ingestion_job j WHERE j.tenant_id=$1 AND j.id=$2 FOR UPDATE OF j',[delivery.tenant_id,delivery.job_id])).rows[0];
    const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    if(!['queued','retry_wait'].includes(row.status)||row.dispatch_revision!==delivery.revision||row.next_run_at.getTime()>now)return null;
    if(denied){await this.failed(client,row,'ACCESS_REVOKED',false);return null}
    if(row.cancel_requested_at){await this.failed(client,row,'USER_CANCELLED',false);return null}
    if(row.attempt_count>=row.max_attempts){await this.failed(client,row,'LEASE_EXPIRED',false);return null}
    const source=(await client.query('SELECT a.* FROM source_asset a JOIN document_version v ON v.tenant_id=a.tenant_id AND v.source_asset_id=a.id WHERE v.tenant_id=$1 AND v.id=$2',[row.tenant_id,row.version_id])).rows[0];
    if(!source||source.scan_status==='rejected'){await this.failed(client,row,'SOURCE_REJECTED',false);return null}
    const lease=randomUUID();const updated=await this.change(client,row,{status:'running',stage:'checking_source',attempt_count:row.attempt_count+1,total_attempts:row.total_attempts+1,error_code:null,dead_letter:false,lease_token:lease,worker_id:workerId,lease_until:new Date(now+this.config.leaseMs),deadline_at:new Date(now+this.config.deadlineMs),heartbeat_at:new Date(now)});
    await client.query("INSERT INTO ingestion_attempt(tenant_id,job_id,run_no,attempt_no,lease_token,worker_id,executor_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'running')",[row.tenant_id,row.id,row.run_no,updated.attempt_count,lease,workerId,row.executor_id]);
    const checkpoint=await client.query("SELECT 1 FROM ingestion_checkpoint WHERE tenant_id=$1 AND job_id=$2 AND step='source_integrity' AND input_sha256=$3",[row.tenant_id,row.id,source.sha256]);
    return {tenant_id:row.tenant_id,job_id:row.id,run_no:row.run_no,lease_token:lease,source:{key:source.object_key,version:source.object_version,size:source.size,sha256:source.sha256,mime:source.mime,filename:source.filename},checkpoint:!!checkpoint.rowCount,parser_version:row.parser_version};
  });}
  heartbeat(lease:AttemptLease){return transaction(this.pool,async client=>{
    const result=await client.query("UPDATE ingestion_job SET lease_until=now()+$5*interval '1 millisecond',heartbeat_at=now() WHERE tenant_id=$1 AND id=$2 AND run_no=$3 AND lease_token=$4 AND status='running' AND lease_until>clock_timestamp() AND deadline_at>clock_timestamp() AND cancel_requested_at IS NULL",[lease.tenant_id,lease.job_id,lease.run_no,lease.lease_token,this.config.leaseMs]);return !!result.rowCount;
  });}
  protected async owned(client:PoolClient,lease:AttemptLease){return (await client.query("SELECT *,clock_timestamp() AS db_now FROM ingestion_job WHERE tenant_id=$1 AND id=$2 AND run_no=$3 AND lease_token=$4 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",[lease.tenant_id,lease.job_id,lease.run_no,lease.lease_token])).rows[0]}
  completeIntegrity(lease:AttemptLease,actualHash:string,continueParsing=false){return transaction(this.pool,async client=>{
    const initial=(await client.query('SELECT j.*,(SELECT version_no FROM document_version v WHERE v.tenant_id=j.tenant_id AND v.id=j.version_id) AS version_no FROM ingestion_job j WHERE j.tenant_id=$1 AND j.id=$2',[lease.tenant_id,lease.job_id])).rows[0];if(!initial)return false;
    let denied=false;try{await this.executor(client,initial)}catch(error){if(error instanceof ResourceError&&[401,404].includes(error.status))denied=true;else throw error}
    const row=await this.owned(client,lease);if(!row)return false;
    if(row.cancel_requested_at){await this.failed(client,row,'USER_CANCELLED',false);return false}
    if(denied){await this.failed(client,row,'ACCESS_REVOKED',false);return false}
    if(row.deadline_at.getTime()<=row.db_now.getTime()){await this.failed(client,row,'WORKER_DEADLINE',true);return false}
    const expected=(await client.query('SELECT v.content_sha256,a.scan_status FROM document_version v JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id WHERE v.tenant_id=$1 AND v.id=$2 FOR SHARE OF a',[row.tenant_id,row.version_id])).rows[0];
    if(expected?.scan_status==='rejected'){await this.failed(client,row,'SOURCE_REJECTED',false);return false}
    if(!expected||expected.content_sha256!==actualHash){await this.failed(client,row,'SOURCE_INTEGRITY_MISMATCH',false);return false}
    await client.query("INSERT INTO ingestion_checkpoint(tenant_id,job_id,step,input_sha256) VALUES($1,$2,'source_integrity',$3) ON CONFLICT DO NOTHING",[row.tenant_id,row.id,actualHash]);
    if(continueParsing){await this.change(client,row,{status:'running',stage:'parsing',error_code:null});return true}
    await this.endAttempt(client,row,'completed',null);await this.change(client,row,{status:'waiting_dependency',stage:'awaiting_parser',error_code:'PARSER_NOT_CONFIGURED',dead_letter:false});return true;
  });}
  failAttempt(lease:AttemptLease,code:string,retryable:boolean){return transaction(this.pool,async client=>{const row=await this.owned(client,lease);if(!row)return false;await this.failed(client,row,row.deadline_at.getTime()<=row.db_now.getTime()?'WORKER_DEADLINE':code,retryable);return true})}
  recoverExpired(){return transaction(this.pool,async client=>{
    const rows=await client.query("SELECT * FROM ingestion_job WHERE status='running' AND lease_until<=clock_timestamp() ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED");
    for(const row of rows.rows)await this.failed(client,row,'LEASE_EXPIRED',true,true);return rows.rowCount??0;
  });}
  reserveDeliveries(){return transaction(this.pool,async client=>{
    const rows=await client.query("SELECT * FROM ingestion_job WHERE status IN ('queued','retry_wait') AND next_run_at<=now() AND (last_enqueued_at IS NULL OR last_enqueued_at<now()-$1*interval '1 millisecond') ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED",[this.config.reconcileMs]);
    const deliveries:IngestionDelivery[]=[];for(const row of rows.rows){await client.query('UPDATE ingestion_job SET dispatch_revision=dispatch_revision+1,last_enqueued_at=now() WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id]);deliveries.push({tenant_id:row.tenant_id,job_id:row.id,revision:row.dispatch_revision+1})}return deliveries;
  });}
  acknowledgeDelivery(delivery:IngestionDelivery){return transaction(this.pool,async client=>{await client.query('UPDATE document_outbox SET dispatched_at=COALESCE(dispatched_at,now()) WHERE id=(SELECT outbox_id FROM ingestion_job WHERE tenant_id=$1 AND id=$2 AND dispatch_revision=$3)',[delivery.tenant_id,delivery.job_id,delivery.revision])})}
  releaseDelivery(delivery:IngestionDelivery){return transaction(this.pool,async client=>{await client.query('UPDATE ingestion_job SET last_enqueued_at=NULL WHERE tenant_id=$1 AND id=$2 AND dispatch_revision=$3 AND status IN (\'queued\',\'retry_wait\')',[delivery.tenant_id,delivery.job_id,delivery.revision])})}
}
