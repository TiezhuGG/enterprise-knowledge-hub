import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext, DocumentVersion, UploadTicket, FinalizedUpload } from '@zhiheng/contracts';
import { ensureIngestionJob, ingestionConfig } from './job-contract';
import { transaction } from './database';
import { ResourceStore, type ListInput } from './store';
import { fail } from './policy';
import { sha256, type ObjectStore } from './objects';
import { validateUpload, verifyBytes, type UploadInput, type UploadLimits } from './upload-validation';

export class UploadStore extends ResourceStore {
  constructor(url:string|undefined,schema:string|undefined,secret:string|undefined,protected readonly objects:ObjectStore,readonly uploadLimits:UploadLimits) {super(url,schema,secret)}
  protected objectStorageIdentity(){return this.objects.storageIdentity}
  protected async quotaLock(client:PoolClient,tenant:string){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`upload-quota:${tenant}`])}
  private ticketView(row:any):UploadTicket {return {ticket_id:row.id,document_id:row.assigned_document_id,status:row.status,expires_at:row.expires_at.toISOString(),max_size:this.uploadLimits.maxBytes,
    upload:{method:'PUT',url:`/api/v1/upload-tickets/${row.id}/content`,headers:{'Content-Type':row.mime}},finalize_url:`/api/v1/upload-tickets/${row.id}/finalize`}}
  private async ticket(client:PoolClient,current:IdentityContext,id:string) {
    const result=await client.query('SELECT * FROM upload_ticket WHERE tenant_id=$1 AND id=$2 AND member_id=$3 FOR UPDATE',[current.tenant_id,id,current.membership_id]);
    const row=result.rows[0];if(!row)fail(404,'RESOURCE_UNAVAILABLE');
    await this.kb(client,current,row.kb_id,'write');
    if(row.target_document_id){const doc=await this.doc(client,current,row.target_document_id,'write');if(doc.kb_id!==row.kb_id)fail(404,'RESOURCE_UNAVAILABLE')}
    if(row.status!=='finalized'&&Date.now()>=row.expires_at.getTime())fail(410,'UPLOAD_EXPIRED');
    return row;
  }
  createUpload(current:IdentityContext,input:UploadInput,key:string,requestId:string) {validateUpload(input,this.uploadLimits);return this.run(current,async(client,member)=>{
    await this.quotaLock(client,member.tenant_id);await this.kb(client,member,input.kb_id,'write');
    const digest=sha256(Buffer.from(key)),payload=sha256(Buffer.from(JSON.stringify(input)));
    const existing=await client.query('SELECT * FROM upload_ticket WHERE tenant_id=$1 AND member_id=$2 AND idempotency_hash=$3',[member.tenant_id,member.membership_id,digest]);
    if(existing.rowCount){const row=existing.rows[0];if(row.payload_hash!==payload)fail(409,'IDEMPOTENCY_KEY_REUSED');await this.ticket(client,member,row.id);return this.ticketView(row)}
    let revision:number|null=null;
    if(input.document_id){const doc=await this.doc(client,member,input.document_id,'write',true);if(doc.kb_id!==input.kb_id)fail(404,'RESOURCE_UNAVAILABLE');revision=doc.row_version}
    const usage=await client.query(`SELECT (SELECT COALESCE(sum(size),0) FROM source_asset WHERE tenant_id=$1) AS stored,
      COALESCE(sum(size),0) AS reserved,count(*) AS count FROM upload_ticket WHERE tenant_id=$1 AND status<>'finalized' AND expires_at>now()`,[member.tenant_id]);
    const used=usage.rows[0];if(Number(used.count)>=this.uploadLimits.tickets||Number(used.stored)+Number(used.reserved)+input.size>this.uploadLimits.tenantBytes)fail(429,'UPLOAD_QUOTA_EXCEEDED');
    const id=randomUUID(),assigned=input.document_id??randomUUID(),objectKey=`tenants/${member.tenant_id}/uploads/${id}`;
    const created=await client.query(`INSERT INTO upload_ticket(tenant_id,id,member_id,kb_id,target_document_id,assigned_document_id,base_revision,filename,size,mime,sha256,object_key,expires_at,idempotency_hash,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+$13*interval '1 second',$14,$15) RETURNING *`,[member.tenant_id,id,member.membership_id,input.kb_id,input.document_id??null,assigned,revision,input.filename,input.size,input.mime,input.sha256,objectKey,this.uploadLimits.ttl,digest,payload]);
    await this.audit(client,member,id,'upload.created',requestId);return this.ticketView(created.rows[0]);
  });}
  getUpload(current:IdentityContext,id:string){return this.run(current,async(client,member)=>this.ticketView(await this.ticket(client,member,id)))}
  receiveUpload(current:IdentityContext,id:string,mime:string,length:number|undefined,read:(expected:number)=>Promise<Buffer>,requestId:string){return this.run(current,async(client,member)=>{
    const ticket=await this.ticket(client,member,id);
    if(ticket.size>this.uploadLimits.maxBytes)fail(413,'UPLOAD_TOO_LARGE');
    if(mime!==ticket.mime)fail(415,'CONTENT_TYPE_MISMATCH');
    if(length!==undefined&&length!==ticket.size)fail(length>ticket.size?413:422,'CONTENT_LENGTH_MISMATCH');
    if(ticket.status==='finalized')fail(409,'UPLOAD_ALREADY_FINALIZED');
    const bytes=await read(ticket.size);verifyBytes(bytes,ticket);
    if(Date.now()>=ticket.expires_at.getTime())fail(410,'UPLOAD_EXPIRED');
    if(ticket.status==='uploaded')return;
    const version=await this.trackedWrite(member.tenant_id,ticket.assigned_document_id,null,'source',()=>this.objects.put(ticket.object_key,bytes,ticket.mime));
    await client.query("UPDATE upload_ticket SET status='uploaded',object_version=$3 WHERE tenant_id=$1 AND id=$2",[member.tenant_id,id,version]);
    await this.audit(client,member,id,'upload.received',requestId);
  });}
  private async result(client:PoolClient,tenant:string,documentId:string,versionId:string):Promise<FinalizedUpload>{
    const row=await client.query('SELECT version_no FROM document_version WHERE tenant_id=$1 AND id=$2 AND document_id=$3',[tenant,versionId,documentId]);
    const job=await ensureIngestionJob(client,tenant,versionId,ingestionConfig().maxAttempts);
    return {document_id:documentId,version_id:versionId,version_no:row.rows[0].version_no,job_id:job.id,status:job.status,status_url:`/api/v1/jobs/${job.id}`};
  }
  finalizeUpload(current:IdentityContext,id:string,checksum:string,requestId:string){return this.run(current,(client,member)=>this.finalizeUploadInTransaction(client,member,id,checksum,requestId));}
  protected async finalizeUploadInTransaction(client:PoolClient,member:IdentityContext,id:string,checksum:string,requestId:string){
    await this.quotaLock(client,member.tenant_id);const ticket=await this.ticket(client,member,id);
    if(checksum!==ticket.sha256)fail(422,'CONTENT_MISMATCH');
    if(ticket.status==='finalized')return this.result(client,member.tenant_id,ticket.assigned_document_id,ticket.version_id);
    if(ticket.status!=='uploaded'||!ticket.object_version)fail(409,'UPLOAD_NOT_RECEIVED');
    const bytes=await this.objects.read(ticket.object_key,ticket.object_version,ticket.size);verifyBytes(bytes,ticket);
    if(Date.now()>=ticket.expires_at.getTime())fail(410,'UPLOAD_EXPIRED');
    if(ticket.target_document_id)await this.doc(client,member,ticket.target_document_id,'write',true);
    const duplicate=await client.query('SELECT id FROM document_version WHERE tenant_id=$1 AND document_id=$2 AND content_sha256=$3',[member.tenant_id,ticket.assigned_document_id,ticket.sha256]);
    if(duplicate.rowCount){const versionId=duplicate.rows[0].id;await client.query("UPDATE upload_ticket SET status='finalized',version_id=$3 WHERE tenant_id=$1 AND id=$2",[member.tenant_id,id,versionId]);return this.result(client,member.tenant_id,ticket.assigned_document_id,versionId)}
    if(ticket.target_document_id){const doc=await client.query('SELECT row_version FROM document WHERE tenant_id=$1 AND id=$2',[member.tenant_id,ticket.target_document_id]);if(doc.rows[0].row_version!==ticket.base_revision)fail(409,'DOCUMENT_CHANGED')}
    else await client.query('INSERT INTO document(tenant_id,id,kb_id,created_by,title) VALUES($1,$2,$3,$4,$5)',[member.tenant_id,ticket.assigned_document_id,ticket.kb_id,member.membership_id,ticket.filename]);
    const number=await client.query('SELECT COALESCE(max(version_no),0)+1 AS next FROM document_version WHERE tenant_id=$1 AND document_id=$2',[member.tenant_id,ticket.assigned_document_id]);
    const assetId=randomUUID(),versionId=randomUUID();
    await client.query('INSERT INTO source_asset(tenant_id,id,object_key,object_version,size,mime,filename,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[member.tenant_id,assetId,ticket.object_key,ticket.object_version,ticket.size,ticket.mime,ticket.filename,ticket.sha256]);
    await client.query('INSERT INTO document_version(tenant_id,id,document_id,version_no,source_asset_id,content_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[member.tenant_id,versionId,ticket.assigned_document_id,number.rows[0].next,assetId,ticket.sha256,member.membership_id]);
    await client.query('UPDATE document SET latest_version_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2',[member.tenant_id,ticket.assigned_document_id,versionId]);
    await client.query("UPDATE upload_ticket SET status='finalized',version_id=$3 WHERE tenant_id=$1 AND id=$2",[member.tenant_id,id,versionId]);
    await client.query("INSERT INTO document_outbox(id,tenant_id,document_id,version_id,event_type) VALUES($1,$2,$3,$4,'document.version_created')",[randomUUID(),member.tenant_id,ticket.assigned_document_id,versionId]);
    await this.audit(client,member,ticket.assigned_document_id,'document.version_created',requestId);
    return this.result(client,member.tenant_id,ticket.assigned_document_id,versionId);
  }
  private versionView(row:any):DocumentVersion{return {id:row.id,document_id:row.document_id,version_no:row.version_no,filename:row.filename,size:row.size,mime:row.mime,sha256:row.content_sha256,scan_status:row.scan_status,created_at:row.created_at.toISOString(),is_latest:row.id===row.latest_version_id,is_published:row.id===row.published_version_id}}
  protected async version(client:PoolClient,member:IdentityContext,documentId:string,versionId:string,download=false){
    const doc=await this.doc(client,member,documentId,download?'download':'read');
    const result=await client.query(`SELECT v.*,a.object_key,a.object_version,a.size,a.mime,a.filename,a.scan_status,d.latest_version_id,d.published_version_id FROM document_version v JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id JOIN document d ON d.tenant_id=v.tenant_id AND d.id=v.document_id WHERE v.tenant_id=$1 AND v.document_id=$2 AND v.id=$3`,[member.tenant_id,documentId,versionId]);
    const row=result.rows[0];if(!row)fail(404,'RESOURCE_UNAVAILABLE');
    const editor=doc.capabilities.some(a=>['write','publish'].includes(a));
    if(!editor&&(row.id!==row.published_version_id||row.scan_status!=='clean'))fail(404,'RESOURCE_UNAVAILABLE');
    if(download&&row.scan_status==='rejected')fail(409,'SOURCE_REJECTED');
    return row;
  }
  getVersion(current:IdentityContext,doc:string,version:string){return this.run(current,async(client,member)=>this.versionView(await this.version(client,member,doc,version)))}
  listVersions(current:IdentityContext,docId:string,input:ListInput){return this.run(current,async(client,member)=>{
    const doc=await this.doc(client,member,docId,'read');const editor=doc.capabilities.some(a=>['write','publish'].includes(a));
    const scope=this.scope(member,input,`versions:${docId}`),after=this.cursor(input,scope);
    const result=await client.query(`SELECT v.*,a.size,a.mime,a.filename,a.scan_status,d.latest_version_id,d.published_version_id FROM document_version v JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id JOIN document d ON d.tenant_id=v.tenant_id AND d.id=v.document_id WHERE v.tenant_id=$1 AND v.document_id=$2
      AND ($3 OR (v.id=d.published_version_id AND a.scan_status='clean')) AND ($4::uuid IS NULL OR v.version_no<(SELECT version_no FROM document_version WHERE tenant_id=$1 AND document_id=$2 AND id=$4)) ORDER BY v.version_no DESC LIMIT $5`,[member.tenant_id,docId,editor,after?.[1]??null,input.limit+1]);
    return this.page(result.rows.map(row=>this.versionView(row)),input,scope);
  });}
  sourceForDownload(current:IdentityContext,doc:string,version:string){return this.run(current,async(client,member)=>{
    const row=await this.version(client,member,doc,version,true);const bytes=await this.objects.read(row.object_key,row.object_version,row.size);
    if(bytes.length!==row.size||sha256(bytes)!==row.content_sha256)fail(422,'STORED_CONTENT_MISMATCH');
    await this.version(client,member,doc,version,true);
    return {bytes,metadata:this.versionView(row)};
  });}
  checkDownload(current:IdentityContext,doc:string,version:string){return this.run(current,(client,member)=>this.version(client,member,doc,version,true).then(()=>{}))}
  /** Explicit GC, never deletes a pinned source asset or an in-flight ticket. */
  cleanupUnusedUploads(tenant:string){return this.runCleanup(tenant)}
  override async close(){await super.close();(this.objects as ObjectStore&{close?:()=>void}).close?.()}
  private async runCleanup(tenant:string){
    return transaction(this.pool,async client=>{
      await this.quotaLock(client,tenant);
      const rows=await client.query(`SELECT t.* FROM upload_ticket t WHERE t.tenant_id=$1 AND t.storage_cleaned_at IS NULL AND (t.expires_at<now() OR t.status='finalized') AND NOT EXISTS(SELECT 1 FROM source_asset a WHERE a.object_key=t.object_key AND a.object_version=t.object_version) LIMIT 100 FOR UPDATE SKIP LOCKED`,[tenant]);
      let removed=0;
      for(const row of rows.rows){const version=row.object_version??await this.objects.findVersion(row.object_key);if(!version){await client.query('UPDATE upload_ticket SET storage_cleaned_at=now() WHERE tenant_id=$1 AND id=$2',[tenant,row.id]);continue}const pinned=await client.query('SELECT 1 FROM source_asset WHERE object_key=$1 AND object_version=$2',[row.object_key,version]);if(pinned.rowCount)continue;await this.objects.remove(row.object_key,version);await client.query('UPDATE upload_ticket SET object_version=NULL,storage_cleaned_at=now() WHERE tenant_id=$1 AND id=$2',[tenant,row.id]);removed++}
      return removed;
    });
  }
}
