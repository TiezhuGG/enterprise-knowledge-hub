import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';import http from 'node:http';
import {createRequire} from 'node:module';import {randomBytes,randomUUID,createHash} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(new URL('../packages/resources/package.json',import.meta.url));
const {databasePool,migrate,S3Objects,UploadStore,uploadLimits}=require('./dist');const {S3Client,ListObjectVersionsCommand,DeleteObjectsCommand,DeleteBucketCommand,PutObjectCommand}=require('@aws-sdk/client-s3');const {RESOURCE_ACTIONS}=require('@zhiheng/contracts');
const ar=createRequire(new URL('../apps/api/package.json',import.meta.url));const {Redis}=ar('ioredis');const {redisConfig}=ar('@zhiheng/config');
const schema='upload_test_'+randomBytes(8).toString('hex'),bucket='upload-test-'+randomBytes(8).toString('hex'),prefix='upload:'+randomUUID()+':';
const tenant='20000000-0000-4000-8000-000000000001',foreignTenant='20000000-0000-4000-8000-000000000002';
const member=n=>`30000000-0000-4000-8000-00000000000${n}`,origin='http://127.0.0.1:5173',secret=randomBytes(32).toString('hex');
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');let logs='';
const storageEnv={...process.env,S3_BUCKET:bucket};const sdk=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.S3_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY},requestChecksumCalculation:'WHEN_REQUIRED'});
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function start(extra={}){const p=await port();const child=spawn(process.execPath,['apps/api/dist/main.js'],{env:{...storageEnv,NODE_ENV:'test',API_HOST:'127.0.0.1',API_PORT:String(p),DATABASE_SCHEMA:schema,DEV_AUTH_ENABLED:'true',DEV_AUTH_SECRET:secret,AUTH_ORIGIN:origin,AUTH_REDIS_PREFIX:prefix,RESOURCE_CURSOR_SECRET:secret,SESSION_TTL_SECONDS:'3600',UPLOAD_MAX_BYTES:'5242880',UPLOAD_ACTIVE_TICKETS:'100',UPLOAD_TTL_SECONDS:'600',...extra},stdio:'pipe'});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);const exited=once(child,'exit');for(let i=0;i<70;i++){try{if((await fetch(`http://127.0.0.1:${p}/api/v1/health/live`)).ok)return{port:p,async stop(){child.kill('SIGTERM');await exited}}}catch{}if(child.exitCode!==null)throw new Error('API exited');await delay(100)}child.kill();throw new Error('API startup timeout')}
async function req(api,path,user,method='GET',body,headers={}){return fetch(`http://127.0.0.1:${api.port}/api/v1${path}`,{method,signal:AbortSignal.timeout(20000),headers:{Origin:origin,'Content-Type':'application/json',...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrf}:{}),...headers},...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})})}
async function login(api,account){const r=await req(api,'/auth/dev-login',null,'POST',{account,secret});assert.equal(r.status,200);const {data}=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrf_token,identity:data.identity}}
async function createKB(api,user,name){const r=await req(api,'/knowledge-bases',user,'POST',{name},{'Idempotency-Key':randomUUID()});assert.equal(r.status,201);return {data:(await r.json()).data,etag:r.headers.get('etag')}}
async function ticket(api,user,kb,bytes,document,extra={},key=randomUUID()){const body={kb_id:kb,filename:'差旅制度.txt',size:bytes.length,mime:'text/plain',sha256:checksum(bytes),...(document?{document_id:document}:{}),...extra};const response=await req(api,'/upload-tickets',user,'POST',body,{'Idempotency-Key':key});return {response,body,key,...(response.status===201?{ticket:(await response.json()).data}:{})}}
async function put(api,user,ticket,bytes,headers={}){return req(api,`/upload-tickets/${ticket.ticket_id}/content`,user,'PUT',bytes,{'Content-Type':ticket.upload.headers['Content-Type'],...headers})}
async function finalize(api,user,ticket,bytes){return req(api,`/upload-tickets/${ticket.ticket_id}/finalize`,user,'POST',{sha256:checksum(bytes)},{'Idempotency-Key':randomUUID()})}
const path=result=>`/documents/${result.document_id}/versions/${result.version_id}`;
async function readResult(response,status){assert.equal(response.status,status,await response.clone().text());return (await response.json()).data}
async function uploaded(api,user,kb,bytes,document){const value=await ticket(api,user,kb,bytes,document);assert.equal(value.response.status,201);assert.equal((await put(api,user,value.ticket,bytes)).status,204);const result=await readResult(await finalize(api,user,value.ticket,bytes),202);return {...value,result}}
async function bucketItems(){const out=await sdk.send(new ListObjectVersionsCommand({Bucket:bucket}));return [...(out.Versions??[]),...(out.DeleteMarkers??[])]}

test('upload tickets, S3 immutable originals, document versions and access boundaries',{timeout:120000},async t=>{
 const root=databasePool(process.env.DATABASE_URL);let db,api,alternate,shared;const objects=new S3Objects(bucket,storageEnv);const redis=new Redis({...redisConfig(),maxRetriesPerRequest:1});redis.on('error',()=>{});
 try{
  await root.query(`CREATE SCHEMA ${schema}`);db=databasePool(process.env.DATABASE_URL,schema);await migrate(process.env.DATABASE_URL,schema);await migrate(process.env.DATABASE_URL,schema);
  execFileSync(process.execPath,['packages/resources/scripts/seed.cjs'],{env:{...process.env,NODE_ENV:'test',DATABASE_SCHEMA:schema},stdio:'pipe'});await objects.initializeDevelopment();
  shared=new UploadStore(process.env.DATABASE_URL,schema,secret,objects,uploadLimits());api=await start();const operator=await login(api,'operator'),employee=await login(api,'employee'),other=await login(api,'other');const kb=await createKB(api,operator,'文件版本测试');
  const data=Buffer.from('差旅报销制度 v1\n原文必须保留。\n','utf8');let first;
  await t.test('ticket creation is idempotent; finalize-before-upload is rejected',async()=>{
   first=await ticket(api,operator,kb.data.id,data);assert.equal(first.response.status,201);
   const replay=await ticket(api,operator,kb.data.id,data,undefined,{},first.key);assert.equal(replay.ticket.ticket_id,first.ticket.ticket_id);
   const conflict=await ticket(api,operator,kb.data.id,Buffer.from('changed'),undefined,{},first.key);assert.equal(conflict.response.status,409);
   assert.equal((await finalize(api,operator,first.ticket,data)).status,409);
  });
  await t.test('unsupported, oversized, traversing and spoofed uploads are rejected',async()=>{
   for(const [extra,status] of [[{filename:'../../escape.txt'},400],[{filename:'bad\r\n.txt'},400],[{filename:'macro.docm',mime:'application/octet-stream'},415],[{size:5242881},413],[{sha256:'false'},400],[{object_key:'foreign'},400]])assert.equal((await ticket(api,operator,kb.data.id,data,undefined,extra)).response.status,status);
   assert.equal((await put(api,operator,first.ticket,Buffer.alloc(data.length,1))).status,422);
   assert.equal((await put(api,operator,first.ticket,data,{'Content-Type':'application/pdf'})).status,415);
   const fakePdf=Buffer.from('not a pdf');const pdf=await ticket(api,operator,kb.data.id,fakePdf,undefined,{filename:'fake.pdf',mime:'application/pdf'});assert.equal((await put(api,operator,pdf.ticket,fakePdf)).status,415);
   const invalid=Buffer.from([0xff,0xfe,0]);const text=await ticket(api,operator,kb.data.id,invalid);assert.equal((await put(api,operator,text.ticket,invalid)).status,415);
  });
  await t.test('stream length limits hold even for chunked bodies and interrupted clients',async()=>{
   const response=await new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:api.port,path:`/api/v1/upload-tickets/${first.ticket.ticket_id}/content`,method:'PUT',headers:{Origin:origin,Cookie:operator.cookie,'X-CSRF-Token':operator.csrf,'Content-Type':'text/plain','Transfer-Encoding':'chunked'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))});request.on('error',reject);request.end(Buffer.alloc(data.length+1))});assert.equal(response,413);
   const interrupted=http.request({hostname:'127.0.0.1',port:api.port,path:`/api/v1/upload-tickets/${first.ticket.ticket_id}/content`,method:'PUT',headers:{Origin:origin,Cookie:operator.cookie,'X-CSRF-Token':operator.csrf,'Content-Type':'text/plain','Content-Length':data.length}});interrupted.on('error',()=>{});interrupted.write(data.subarray(0,4));await delay(80);interrupted.destroy();await delay(100);
   const status=await readResult(await req(api,`/upload-tickets/${first.ticket.ticket_id}`,operator),200);assert.equal(status.status,'open');
   assert.equal((await put(api,operator,first.ticket,data)).status,204);assert.equal((await put(api,operator,first.ticket,data)).status,204);
  });
  await t.test('concurrent finalize creates one immutable version and one outbox event',async()=>{
   const responses=await Promise.all([finalize(api,operator,first.ticket,data),finalize(api,operator,first.ticket,data)]);const [a,b]=await Promise.all(responses.map(r=>readResult(r,202)));assert.equal(a.version_id,b.version_id);first.result=a;assert.equal(a.status,'queued');
   assert.equal((await db.query('SELECT count(*) FROM document_outbox')).rows[0].count,'1');assert.equal((await db.query('SELECT count(*) FROM document_version')).rows[0].count,'1');
   await assert.rejects(()=>db.query('UPDATE document_version SET version_no=99 WHERE id=$1',[a.version_id]),e=>e.code==='23514');
   await assert.rejects(()=>db.query("UPDATE source_asset SET filename='changed'"),e=>e.code==='23514');
  });
  await t.test('original bytes download with safe headers and strict byte ranges',async()=>{
   const response=await req(api,`${path(first.result)}/content`,operator);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
   const range=await req(api,`${path(first.result)}/content`,operator,'GET',undefined,{Range:'bytes=0-8'});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),data.subarray(0,9));
   const suffix=await req(api,`${path(first.result)}/content`,operator,'GET',undefined,{Range:'bytes=-4'});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),data.subarray(-4));
   assert.equal((await req(api,`${path(first.result)}/content`,operator,'GET',undefined,{Range:'bytes=99999-'})).status,416);
   const metadata=await readResult(await req(api,path(first.result),operator),200);assert.equal(metadata.sha256,checksum(data));assert.ok(!JSON.stringify(metadata).includes('object_key'));
  });
  await t.test('repeated same-document content reuses a version; same bytes in a new document stay separate',async()=>{
   const duplicate=await uploaded(api,operator,kb.data.id,data,first.result.document_id);assert.equal(duplicate.result.version_id,first.result.version_id);
   const separate=await uploaded(api,operator,kb.data.id,data);assert.notEqual(separate.result.document_id,first.result.document_id);assert.notEqual(separate.result.version_id,first.result.version_id);
   await assert.rejects(()=>db.query('UPDATE document SET latest_version_id=$2 WHERE tenant_id=$3 AND id=$1',[first.result.document_id,separate.result.version_id,tenant]),e=>e.code==='23503');
  });
  await t.test('late older upload cannot replace a newer registered version',async()=>{
   const staleData=Buffer.from('old candidate'),newData=Buffer.from('current v2');const stale=await ticket(api,operator,kb.data.id,staleData,first.result.document_id);assert.equal((await put(api,operator,stale.ticket,staleData)).status,204);
   const fresh=await uploaded(api,operator,kb.data.id,newData,first.result.document_id);assert.equal(fresh.result.version_no,2);
   assert.equal((await finalize(api,operator,stale.ticket,staleData)).status,409);
   const page=await req(api,`/documents/${first.result.document_id}/versions?limit=1`,operator);const firstPage=await page.json();assert.equal(firstPage.data[0].id,fresh.result.version_id);assert.equal(firstPage.page.has_more,true);
   const next=await req(api,`/documents/${first.result.document_id}/versions?limit=1&cursor=${encodeURIComponent(firstPage.page.next_cursor)}`,operator);assert.equal((await next.json()).data[0].id,first.result.version_id);
   assert.equal((await req(api,`/documents/${fresh.result.document_id}/versions/${randomUUID()}/content`,operator)).status,404);
  });
  await t.test('object version pins survive later S3 writes and originals are not public',async()=>{
   const asset=(await db.query('SELECT a.* FROM source_asset a JOIN document_version v ON v.tenant_id=a.tenant_id AND v.source_asset_id=a.id WHERE v.id=$1',[first.result.version_id])).rows[0];
   await sdk.send(new PutObjectCommand({Bucket:bucket,Key:asset.object_key,Body:'external overwrite'}));
   const response=await req(api,`${path(first.result)}/content`,operator);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);
   const anonymous=await fetch(`${process.env.S3_ENDPOINT}/${bucket}/${asset.object_key}?versionId=${encodeURIComponent(asset.object_version)}`);assert.equal(anonymous.status,403);
  });
  await t.test('draft visibility, tenant boundaries and ticket ownership are rechecked',async()=>{
   const update=await req(api,`/knowledge-bases/${kb.data.id}/acl`,operator,'PUT',{grants:[{principal_type:'member',principal_id:member(3),actions:RESOURCE_ACTIONS},{principal_type:'member',principal_id:member(1),actions:RESOURCE_ACTIONS}]},{'If-Match':kb.etag});assert.equal(update.status,200);kb.etag=update.headers.get('etag');
   for(const user of [employee,other]){assert.equal((await req(api,path(first.result),user)).status,404);assert.equal((await req(api,`${path(first.result)}/content`,user)).status,404);assert.equal((await req(api,`/upload-tickets/${first.ticket.ticket_id}`,user)).status,404)}
   assert.equal((await ticket(api,employee,kb.data.id,data)).response.status,404);
   await db.query("UPDATE membership SET role='operator' WHERE tenant_id=$1 AND id=$2",[tenant,member(1)]);
   assert.equal((await put(api,employee,first.ticket,data)).status,404);assert.equal((await finalize(api,employee,first.ticket,data)).status,404);
   await db.query("UPDATE membership SET role='employee' WHERE tenant_id=$1 AND id=$2",[tenant,member(1)]);
   const foreignKB=await createKB(api,operator,'another parent');assert.equal((await ticket(api,operator,foreignKB.data.id,data,first.result.document_id)).response.status,404);
  });
  await t.test('readers only see a clean published version; rejected originals cannot download',async()=>{
   // Explicit lifecycle fixture for future publishing integration, not a public publish endpoint.
   await db.query("UPDATE document SET status='active',published_version_id=$2 WHERE id=$1",[first.result.document_id,first.result.version_id]);
   assert.equal((await req(api,path(first.result),employee)).status,404);
   await db.query("UPDATE source_asset SET scan_status='clean' WHERE id=(SELECT source_asset_id FROM document_version WHERE id=$1)",[first.result.version_id]);
   assert.equal((await req(api,`${path(first.result)}/content`,employee)).status,200);
   const page=await req(api,`/documents/${first.result.document_id}/versions`,employee);const json=await page.json();assert.deepEqual(json.data.map(v=>v.id),[first.result.version_id]);assert.equal(json.page.has_more,false);
   await db.query("UPDATE source_asset SET scan_status='rejected' WHERE id=(SELECT source_asset_id FROM document_version WHERE id=$1)",[first.result.version_id]);assert.equal((await req(api,`${path(first.result)}/content`,operator)).status,409);assert.equal((await req(api,path(first.result),employee)).status,404);
   await db.query("UPDATE source_asset SET scan_status='pending' WHERE id=(SELECT source_asset_id FROM document_version WHERE id=$1)",[first.result.version_id]);await db.query("UPDATE document SET status='draft',published_version_id=NULL WHERE id=$1",[first.result.document_id]);
  });
  await t.test('revoked write permission blocks finalization of an already uploaded file',async()=>{
   const delegated=await createKB(api,operator,'撤权上传测试'),bytes=Buffer.from('not finalized');const value=await ticket(api,operator,delegated.data.id,bytes);assert.equal((await put(api,operator,value.ticket,bytes)).status,204);
   const changed=await req(api,`/knowledge-bases/${delegated.data.id}/acl`,operator,'PUT',{grants:[{principal_type:'member',principal_id:member(4),actions:RESOURCE_ACTIONS}]},{'If-Match':delegated.etag});assert.equal(changed.status,200);
   assert.equal((await finalize(api,operator,value.ticket,bytes)).status,404);assert.equal((await db.query('SELECT count(*) FROM document WHERE id=$1',[value.ticket.document_id])).rows[0].count,'0');
  });
  await t.test('Markdown and PDF signatures are stored pending rather than marked parsed',async()=>{
   for(const [bytes,filename,mime] of [[Buffer.from('# 制度\n正文'),'policy.md','text/markdown'],[Buffer.from('%PDF-1.7\n%%EOF'),'policy.pdf','application/pdf']]){const value=await ticket(api,operator,kb.data.id,bytes,undefined,{filename,mime});assert.equal((await put(api,operator,value.ticket,bytes)).status,204);const result=await readResult(await finalize(api,operator,value.ticket,bytes),202);const metadata=await readResult(await req(api,path(result),operator),200);assert.equal(metadata.scan_status,'pending');assert.equal(metadata.is_published,false);}
  });
  await t.test('S3 write followed by DB rollback can be safely retried and orphaned data collected',async()=>{
   await db.query(`CREATE FUNCTION fail_upload_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$; CREATE TRIGGER fail_upload BEFORE UPDATE ON upload_ticket FOR EACH ROW WHEN (NEW.status='uploaded') EXECUTE FUNCTION fail_upload_update()`);
   const recovery=await ticket(api,operator,kb.data.id,Buffer.from('recover me'));assert.equal((await put(api,operator,recovery.ticket,Buffer.from('recover me'))).status,503);
   const orphan=await ticket(api,operator,kb.data.id,Buffer.from('orphan'));assert.equal((await put(api,operator,orphan.ticket,Buffer.from('orphan'))).status,503);
   await db.query('DROP TRIGGER fail_upload ON upload_ticket; DROP FUNCTION fail_upload_update()');
   assert.equal((await put(api,operator,recovery.ticket,Buffer.from('recover me'))).status,204);assert.equal((await finalize(api,operator,recovery.ticket,Buffer.from('recover me'))).status,202);
   const orphanRow=(await db.query('SELECT * FROM upload_ticket WHERE id=$1',[orphan.ticket.ticket_id])).rows[0];await db.query("UPDATE upload_ticket SET expires_at=now()-interval '1 second' WHERE id=$1",[orphanRow.id]);
   const removed=await shared.cleanupUnusedUploads(tenant);assert.ok(removed>=1);assert.equal(await objects.findVersion(orphanRow.object_key),null);
   assert.equal((await req(api,`${path(first.result)}/content`,operator)).status,200);
  });
  await t.test('expired reservations and concurrent quota checks do not overbook storage',async()=>{
   alternate=await start({UPLOAD_TTL_SECONDS:'1'});const expired=await ticket(alternate,operator,kb.data.id,Buffer.from('expires'));await delay(1100);assert.equal((await req(alternate,`/upload-tickets/${expired.ticket.ticket_id}`,operator)).status,410);await alternate.stop();alternate=null;
   await db.query("UPDATE membership SET role='operator',can_create_kb=true WHERE tenant_id=$1 AND id=$2",[foreignTenant,member(2)]);const foreignKB=await createKB(api,other,'quota');alternate=await start({UPLOAD_TENANT_BYTES:'10'});
   const values=await Promise.all([ticket(alternate,other,foreignKB.data.id,Buffer.from('123456')),ticket(alternate,other,foreignKB.data.id,Buffer.from('abcdef'))]);assert.deepEqual(values.map(x=>x.response.status).sort(),[201,429]);await alternate.stop();alternate=null;
  });
  await t.test('download revocation stops subsequent chunks and new downloads',async()=>{
   const large=Buffer.alloc(3*1024*1024,97),value=await uploaded(api,operator,kb.data.id,large);const response=await req(api,`${path(value.result)}/content`,operator);assert.equal(response.status,200);const reader=response.body.getReader();let received=(await reader.read()).value.length;
   const changed=await req(api,`/knowledge-bases/${kb.data.id}/acl`,operator,'PUT',{grants:[{principal_type:'member',principal_id:member(3),actions:RESOURCE_ACTIONS.filter(action=>action!=='download')}]},{'If-Match':kb.etag});assert.equal(changed.status,200);
   let interrupted=false;try{for(;;){const item=await reader.read();if(item.done)break;received+=item.value.length}}catch{interrupted=true}assert.ok(interrupted);assert.ok(received<large.length);assert.equal((await req(api,`${path(value.result)}/content`,operator)).status,404);
   kb.etag=changed.headers.get('etag');
  });
  await t.test('S3 outage returns failure without manufacturing a version',async()=>{
   const missing=await ticket(api,operator,kb.data.id,Buffer.from('offline'));const endpoint=`http://127.0.0.1:${await port()}`;alternate=await start({S3_ENDPOINT:endpoint});const count=(await db.query('SELECT count(*) FROM document_version')).rows[0].count;
   assert.equal((await put(alternate,operator,missing.ticket,Buffer.from('offline'))).status,503);assert.equal((await db.query('SELECT count(*) FROM document_version')).rows[0].count,count);
  });
  assert.ok(!logs.includes(secret));assert.ok(!logs.includes(data.toString()));
 }finally{
  await alternate?.stop();await api?.stop();await shared?.close();objects.close();
  try{const objects=await bucketItems();if(objects.length)await sdk.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:objects.map(item=>({Key:item.Key,VersionId:item.VersionId}))}}));await sdk.send(new DeleteBucketCommand({Bucket:bucket}))}finally{sdk.destroy()}
  await db?.end();await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();
  try{if(redis.status==='ready'){const keys=await redis.keys(`${prefix}*`);if(keys.length)await redis.del(...keys)}}finally{redis.disconnect()}
 }
});
