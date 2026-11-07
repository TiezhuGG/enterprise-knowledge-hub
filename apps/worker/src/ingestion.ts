import { ChunkFailure } from '@zhiheng/chunker';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { parseIsolated,parserLimits,PARSER_VERSION,ParserFailure } from '@zhiheng/parser';
import { redisConfig } from '@zhiheng/config';
import { INGEST_JOB_NAME, type IngestionDelivery } from '@zhiheng/contracts';
import { IndexingStore, embeddingProfile, IndexFailure, S3Objects, ingestionConfig, uploadLimits, sha256, ResourceError, type AttemptLease } from '@zhiheng/resources';

export class IngestionRuntime {
  private readonly config=ingestionConfig();
  private readonly limits=parserLimits();
  private readonly indexProfile=embeddingProfile();
  private readonly objects=new S3Objects(process.env.S3_BUCKET??'');
  private readonly store=new IndexingStore(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA,process.env.RESOURCE_CURSOR_SECRET,this.objects,uploadLimits(),this.config);
  private readonly workerId=randomUUID();
  private queue?:Queue<IngestionDelivery>;
  private worker?:Worker<IngestionDelivery>;
  private timer?:ReturnType<typeof setInterval>;
  private ticking=false;
  private stopping=false;
  private readonly active=new Set<AbortController>();
  async start(){
    if(!process.env.DATABASE_URL)throw new Error('Ingestion requires PostgreSQL');
    this.queue=new Queue(this.config.queue,{connection:{...redisConfig(),maxRetriesPerRequest:1,enableOfflineQueue:false,commandTimeout:3000}});
    this.queue.on('error',()=>console.error('Ingestion delivery unavailable'));
    this.worker=new Worker(this.config.queue,job=>this.process(job),{connection:redisConfig(),concurrency:2,lockDuration:30000});
    this.worker.on('error',()=>console.error('Ingestion transport unavailable'));
    this.worker.on('failed',()=>console.error('Ingestion transport delivery failed'));
    await this.worker.waitUntilReady();
    await this.tick();this.timer=setInterval(()=>void this.tick(),this.config.pollMs);
    console.log('Ingestion worker ready');
  }
  private async tick(){
    if(this.ticking||this.stopping)return;this.ticking=true;
    try{
      await this.store.recoverExpired();
      if(this.config.parserEnabled)await this.store.resumeWaitingParsers();
      if(this.config.chunkerEnabled)await this.store.resumeWaitingChunkers();
      if(this.indexProfile)await this.store.resumeWaitingIndexers(this.indexProfile);
      for(const delivery of await this.store.reserveDeliveries()){
        if(this.stopping){await this.store.releaseDelivery(delivery);continue}
        try{await this.queue!.add(INGEST_JOB_NAME,delivery,{jobId:`ingest-${delivery.job_id}-${delivery.revision}`,attempts:1,removeOnComplete:true,removeOnFail:100});await this.store.acknowledgeDelivery(delivery)}
        catch{await this.store.releaseDelivery(delivery);console.error('Ingestion delivery deferred');break}
      }
    }catch{console.error('Ingestion maintenance unavailable')}
    finally{this.ticking=false}
  }
  private valid(data:IngestionDelivery){return data&&Object.keys(data).every(key=>['job_id','tenant_id','revision'].includes(key))&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.job_id)&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.tenant_id)&&Number.isInteger(data.revision)&&data.revision>0}
  private async process(job:Job<IngestionDelivery>){
    if(job.name!==INGEST_JOB_NAME||!this.valid(job.data))throw new Error('Invalid ingestion delivery');
    const lease=await this.store.claim(job.data,this.workerId);if(!lease)return;
    const controller=new AbortController();this.active.add(controller);let renewing=false;
    const pulse=setInterval(()=>{
      if(renewing)return;renewing=true;
      this.store.heartbeat(lease).then(valid=>{if(!valid)controller.abort()}).catch(()=>controller.abort()).finally(()=>{renewing=false});
    },Math.max(200,Math.floor(this.config.leaseMs/3)));
    const deadline=setTimeout(()=>controller.abort(),this.config.deadlineMs);
    try{
      const indexed=await this.store.resumeChunked(lease,!!this.indexProfile);if(indexed==='closed')return;if(indexed==='ready'){await this.store.indexLease(lease,this.indexProfile!,controller.signal);return}
      const prior=await this.store.resumeParsed(lease,this.config.chunkerEnabled);
      if(prior==='closed')return;if(prior==='ready'){const chunked=await this.store.chunkLease(lease,controller.signal,!!this.indexProfile);if(chunked&&this.indexProfile)await this.store.indexLease(lease,this.indexProfile,controller.signal);return}
      let digest=lease.source.sha256,bytes:Buffer|undefined;
      if(!lease.checkpoint){bytes=await this.objects.read(lease.source.key,lease.source.version,lease.source.size,controller.signal);digest=sha256(bytes);if(bytes.length!==lease.source.size||digest!==lease.source.sha256){await this.store.failAttempt(lease,'SOURCE_INTEGRITY_MISMATCH',false);return}}
      if(controller.signal.aborted){await this.fail(lease,'WORKER_ERROR');return}
      const proceed=await this.store.completeIntegrity(lease,digest,this.config.parserEnabled);
      if(!proceed||!this.config.parserEnabled)return;
      if(lease.parser_version!==PARSER_VERSION){await this.store.failAttempt(lease,'PARSER_VERSION_UNSUPPORTED',false);return}
      bytes??=await this.objects.read(lease.source.key,lease.source.version,lease.source.size,controller.signal);
      if(sha256(bytes)!==lease.source.sha256){await this.store.failAttempt(lease,'SOURCE_INTEGRITY_MISMATCH',false);return}
      const output=await parseIsolated(bytes,lease.source.mime==='text/plain'&&lease.source.filename.toLowerCase().endsWith('.md')?'text/markdown':lease.source.mime,controller.signal,this.limits);
      if(controller.signal.aborted){await this.fail(lease,'WORKER_ERROR');return}
      const saved=await this.store.completeParsing(lease,output,this.config.chunkerEnabled);
      if(saved&&this.config.chunkerEnabled){const chunked=await this.store.chunkLease(lease,controller.signal,!!this.indexProfile);if(chunked&&this.indexProfile)await this.store.indexLease(lease,this.indexProfile,controller.signal);}
    }catch(error){if(error instanceof ResourceError&&error.code==='EMBEDDING_OUTCOME_UNKNOWN'){await this.store.failAttempt(lease,error.code,false)}else if(error instanceof IndexFailure&&error.code!=='INDEX_CANCELLED'){await this.store.failAttempt(lease,error.code,error.retryable,error.retryAfterMs)}else if(error instanceof ChunkFailure&&error.code!=='CHUNK_CANCELLED'){await this.store.failAttempt(lease,error.code,false)}else if(error instanceof ParserFailure&&error.code!=='PARSER_CANCELLED'){await this.store.failAttempt(lease,error.code,false)}else if(error instanceof ResourceError&&error.status===422){await this.store.failAttempt(lease,error.code.startsWith('PARSE')||error.code.startsWith('CHUNK')?error.code:'SOURCE_INTEGRITY_MISMATCH',false)}else await this.fail(lease,this.stopping||controller.signal.aborted?'WORKER_ERROR':'SOURCE_UNAVAILABLE')}
    finally{clearInterval(pulse);clearTimeout(deadline);this.active.delete(controller)}
  }
  private async fail(lease:AttemptLease,code:'SOURCE_UNAVAILABLE'|'WORKER_DEADLINE'|'WORKER_ERROR'){
    try{await this.store.failAttempt(lease,code,true)}catch{console.error('Ingestion result deferred until lease recovery')}
  }
  async stop(){
    this.stopping=true;if(this.timer)clearInterval(this.timer);for(const controller of this.active)controller.abort();
    await this.worker?.close();
    while(this.ticking)await new Promise(resolve=>setTimeout(resolve,25));
    await this.queue?.close();await this.store.close();
  }
}
