import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
export const INTAKE_PIPELINE='intake-v1';
export interface IngestionConfig {leaseMs:number;deadlineMs:number;retryMs:number;reconcileMs:number;pollMs:number;queue:string;maxAttempts:number}
export function ingestionConfig(env:NodeJS.ProcessEnv=process.env):IngestionConfig {
  const number=(key:string,fallback:number,min:number,max:number)=>{const value=Number(env[key]??fallback);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid ${key}`);return value};
  const queue=env.INGEST_QUEUE??'knowledge-ingestion';if(!/^[a-zA-Z0-9_-]{1,100}$/.test(queue))throw new Error('Invalid INGEST_QUEUE');
  const leaseMs=number('INGEST_LEASE_MS',15000,1000,120000),deadlineMs=number('INGEST_DEADLINE_MS',120000,1000,600000);
  return {leaseMs,deadlineMs,retryMs:number('INGEST_RETRY_MS',1000,100,60000),reconcileMs:number('INGEST_RECONCILE_MS',10000,500,300000),pollMs:number('INGEST_POLL_MS',1000,100,10000),queue,maxAttempts:number('INGEST_MAX_ATTEMPTS',3,1,10)};
}
export async function ensureIngestionJob(client:PoolClient,tenant:string,version:string,maxAttempts=3){
  const inserted=await client.query(`INSERT INTO ingestion_job(tenant_id,id,kb_id,document_id,version_id,outbox_id,owner_id,executor_id,max_attempts)
    SELECT v.tenant_id,$3,d.kb_id,v.document_id,v.id,o.id,v.created_by,v.created_by,$4 FROM document_version v
    JOIN document d ON d.tenant_id=v.tenant_id AND d.id=v.document_id JOIN document_outbox o ON o.tenant_id=v.tenant_id AND o.version_id=v.id
    WHERE v.tenant_id=$1 AND v.id=$2 ON CONFLICT(tenant_id,version_id,pipeline_version) DO NOTHING RETURNING id`,[tenant,version,randomUUID(),maxAttempts]);
  if(inserted.rowCount){const jobId=inserted.rows[0].id;await client.query('UPDATE ingestion_job SET event_seq=1 WHERE tenant_id=$1 AND id=$2',[tenant,jobId]);await client.query("INSERT INTO ingestion_event(tenant_id,job_id,seq,run_no,status,stage) VALUES($1,$2,1,1,'queued','queued')",[tenant,jobId])}
  const result=await client.query('SELECT id,status FROM ingestion_job WHERE tenant_id=$1 AND version_id=$2 AND pipeline_version=$3',[tenant,version,INTAKE_PIPELINE]);
  return result.rows[0] as {id:string;status:import('@zhiheng/contracts').IngestionStatus};
}
