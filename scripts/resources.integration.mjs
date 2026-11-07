import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require=createRequire(new URL('../packages/resources/package.json',import.meta.url));
const { ResourceStore, databasePool, migrate }=require('./dist');
const { RESOURCE_ACTIONS }=require('@zhiheng/contracts');
const apiRequire=createRequire(new URL('../apps/api/package.json',import.meta.url));
const { Redis }=apiRequire('ioredis'); const { redisConfig }=apiRequire('@zhiheng/config');
const schema=`resource_test_${randomBytes(8).toString('hex')}`,prefix=`resources:${randomUUID()}:`;
const secret=randomBytes(32).toString('hex'),origin='http://127.0.0.1:5173';
const tenant='20000000-0000-4000-8000-000000000001',foreignTenant='20000000-0000-4000-8000-000000000002';
const member=n=>`30000000-0000-4000-8000-00000000000${n}`;
const actor=n=>`10000000-0000-4000-8000-00000000000${n}`;
const owner={principal_type:'member',principal_id:member(3),actions:[...RESOURCE_ACTIONS]};
const reader={principal_type:'member',principal_id:member(1),actions:['read','download']};
let logs='';
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function start(extra={}){
 const port=await freePort();
 const child=spawn(process.execPath,['apps/api/dist/main.js'],{env:{...process.env,NODE_ENV:'test',API_HOST:'127.0.0.1',API_PORT:String(port),DATABASE_SCHEMA:schema,DEV_AUTH_ENABLED:'true',DEV_AUTH_SECRET:secret,AUTH_ORIGIN:origin,AUTH_REDIS_PREFIX:prefix,RESOURCE_CURSOR_SECRET:secret,DEV_DISABLED_ACCOUNTS:'',...extra},stdio:'pipe'});
 child.stdout.on('data',data=>{logs+=data});child.stderr.on('data',data=>{logs+=data});const exited=once(child,'exit');
 for(let i=0;i<70;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/v1/health/live`)).ok)return {port,async stop(){child.kill('SIGTERM');await exited}}}catch{}if(child.exitCode!==null)throw new Error('API startup failed');await delay(100)}
 child.kill('SIGTERM');throw new Error('API startup timeout');
}
async function request(api,path,user,method='GET',body,headers={}){
 return fetch(`http://127.0.0.1:${api.port}/api/v1${path}`,{method,signal:AbortSignal.timeout(10000),headers:{Origin:origin,'Content-Type':'application/json',...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function login(api,account){const r=await request(api,'/auth/dev-login',null,'POST',{account,secret});assert.equal(r.status,200);const {data}=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrf_token,identity:data.identity};}
async function create(api,user,name,key=randomUUID()){
 const response=await request(api,'/knowledge-bases',user,'POST',{name},{'Idempotency-Key':key});assert.equal(response.status,201,await failure(response));return {data:(await response.json()).data,etag:response.headers.get('etag'),key};
}
async function failure(response){return response.ok?'':await response.clone().text();}
async function acl(api,user,kb,grants,etag){return request(api,`/knowledge-bases/${kb}/acl`,user,'PUT',{grants},{'If-Match':etag});}

test('PostgreSQL resource lifecycle, tenant isolation and shared authorization', {timeout:60000},async t=>{
 const adminDb=databasePool(process.env.DATABASE_URL);let db,api,policy,secondPolicy;
 const redis=new Redis({...redisConfig(),maxRetriesPerRequest:1});redis.on('error',()=>{});
 try{
  assert.ok(adminDb,'DATABASE_URL required');await adminDb.query(`CREATE SCHEMA ${schema}`);db=databasePool(process.env.DATABASE_URL,schema);
  await migrate(process.env.DATABASE_URL,schema);await migrate(process.env.DATABASE_URL,schema);
  execFileSync(process.execPath,['packages/resources/scripts/seed.cjs'],{env:{...process.env,NODE_ENV:'test',DATABASE_SCHEMA:schema},stdio:'pipe'});
  api=await start();policy=new ResourceStore(process.env.DATABASE_URL,schema,secret);secondPolicy=new ResourceStore(process.env.DATABASE_URL,schema,secret);
  const operator=await login(api,'operator'),employee=await login(api,'employee'),admin=await login(api,'admin'),other=await login(api,'other');
  let kb=await create(api,operator,'制度资料库');
  const endpoint=`/knowledge-bases/${kb.data.id}`;
  await t.test('default private; workspace admin and foreign tenant have no bypass',async()=>{
   for(const user of [employee,admin,other]){assert.equal((await request(api,endpoint,user)).status,404);const list=await request(api,'/knowledge-bases',user);assert.deepEqual((await list.json()).data,[]);}
   assert.equal((await request(api,'/knowledge-bases',null)).status,401);
   assert.equal((await request(api,'/knowledge-bases',employee,'POST',{name:'forbidden'},{'Idempotency-Key':randomUUID()})).status,403);
   assert.equal((await request(api,'/knowledge-bases',operator,'POST',{name:'forged',tenant_id:foreignTenant},{'Idempotency-Key':randomUUID()})).status,400);
   assert.equal((await request(api,endpoint,other,'GET',undefined,{'X-Tenant-Id':tenant,'X-User-Id':actor(3)})).status,404);
  });
  await t.test('create is transactionally idempotent, including concurrent retries',async()=>{
   const key=randomUUID();const [a,b]=await Promise.all([create(api,operator,'幂等资料库',key),create(api,operator,'幂等资料库',key)]);assert.equal(a.data.id,b.data.id);
   const conflict=await request(api,'/knowledge-bases',operator,'POST',{name:'different'},{'Idempotency-Key':key});assert.equal(conflict.status,409);
   const audit=await db.query("SELECT count(*) FROM resource_audit WHERE resource_id=$1 AND action='knowledge_base.created'",[a.data.id]);assert.equal(audit.rows[0].count,'1');
  });
  await t.test('ACL writes require CSRF, current ETag and a valid same-tenant manager',async()=>{
   assert.equal((await request(api,`${endpoint}/acl`,operator,'PUT',{grants:[owner]},{'If-Match':kb.etag,'X-CSRF-Token':'wrong'})).status,403);
   assert.equal((await request(api,`${endpoint}/acl`,operator,'PUT',{grants:[owner]})).status,428);
   assert.equal((await acl(api,operator,kb.data.id,[reader],kb.etag)).status,409);
   assert.equal((await acl(api,operator,kb.data.id,[owner,{...reader,principal_id:member(2)}],kb.etag)).status,400);
   assert.equal((await acl(api,operator,kb.data.id,[owner,owner],kb.etag)).status,400);
   const changed=await acl(api,operator,kb.data.id,[owner,{...reader,actions:[...RESOURCE_ACTIONS]}],kb.etag);assert.equal(changed.status,200,await failure(changed));
   assert.equal((await acl(api,operator,kb.data.id,[owner],kb.etag)).status,412);kb.etag=changed.headers.get('etag');
  });
  await t.test('role and resource ACL intersect; worker callers cannot forge roles',async()=>{
   const response=await request(api,endpoint,employee);assert.equal(response.status,200);const caps=(await response.json()).data.capabilities;assert.deepEqual(caps,['read','download']);
   assert.equal((await request(api,`${endpoint}/acl`,employee)).status,404);
   assert.equal((await request(api,endpoint,employee,'PATCH',{name:'hacked'},{'If-Match':kb.etag})).status,404);
   await assert.rejects(()=>secondPolicy.authorizeKnowledgeBase({...employee.identity,role:'admin',capabilities:['knowledge:create']},kb.data.id,'write'),error=>error.status===404);
   assert.ok((await policy.authorizeKnowledgeBase(operator.identity,kb.data.id,'write')).capabilities.includes('write'));
  });
  const hidden=await create(api,operator,'HIDDEN_SENTINEL');
  await t.test('authorization filters precede pagination; cursor is signed and scoped',async()=>{
   const visibleIds=[];
   for(let i=0;i<3;i++){const value=await create(api,operator,`员工资料 ${i}`);const grant=await acl(api,operator,value.data.id,[owner,reader],value.etag);assert.equal(grant.status,200);visibleIds.push(value.data.id)}
   await db.query("UPDATE knowledge_base SET created_at='2026-11-07T00:00:00.123456Z' WHERE tenant_id=$1",[tenant]);
   const response=await request(api,'/knowledge-bases?limit=1',employee),first=await response.json();assert.equal(first.data.length,1);assert.equal(first.page.has_more,true);assert.ok(!('total' in first));
   assert.ok(!JSON.stringify(first).includes('HIDDEN_SENTINEL'));
   const cursor=first.page.next_cursor;const collected=[first.data[0].id];let next=cursor;
   while(next){const page=await (await request(api,`/knowledge-bases?limit=1&cursor=${encodeURIComponent(next)}`,employee)).json();collected.push(...page.data.map(k=>k.id));next=page.page.next_cursor}
   assert.equal(new Set(collected).size,4);for(const id of visibleIds)assert.ok(collected.includes(id));
   assert.equal((await request(api,`/knowledge-bases?limit=1&cursor=${encodeURIComponent(cursor+'x')}`,employee)).status,400);
   assert.equal((await request(api,`/knowledge-bases?limit=1&cursor=${encodeURIComponent(cursor)}`,admin)).status,400);
   assert.equal((await request(api,`/knowledge-bases?limit=2&cursor=${encodeURIComponent(cursor)}`,employee)).status,400);
  });
  await t.test('stable group allowlist and immediate group-membership revocation',async()=>{
   const group=randomUUID();await db.query('INSERT INTO workspace_group VALUES($1,$2,$3)',[tenant,group,'试点读者']);await db.query('INSERT INTO group_member VALUES($1,$2,$3)',[tenant,group,member(1)]);
   const response=await acl(api,operator,hidden.data.id,[owner,{principal_type:'group',principal_id:group,actions:['read']}],hidden.etag);assert.equal(response.status,200);
   assert.equal((await request(api,`/knowledge-bases/${hidden.data.id}`,employee)).status,200);
   await db.query('DELETE FROM group_member WHERE tenant_id=$1 AND group_id=$2 AND member_id=$3',[tenant,group,member(1)]);
   assert.equal((await request(api,`/knowledge-bases/${hidden.data.id}`,employee)).status,404);
  });
  const inherited=randomUUID(),restricted=randomUUID(),draft=randomUUID(),mismatch=randomUUID();
  await db.query(`INSERT INTO document(tenant_id,id,kb_id,created_by,title,status,acl_mode) VALUES($1,$2,$3,$4,'继承制度','active','inherit'),($1,$5,$3,$4,'RESTRICTED_SENTINEL','active','restricted'),($1,$6,$3,$4,'DRAFT_SENTINEL','draft','inherit'),($1,$7,$3,$4,'MISMATCH_SENTINEL','draft','restricted')`,[tenant,inherited,kb.data.id,member(3),restricted,draft,mismatch]);
  await t.test('document ownership constraints prevent cross-tenant associations',async()=>{
   await assert.rejects(()=>db.query('INSERT INTO document(tenant_id,id,kb_id,created_by,title) VALUES($1,$2,$3,$4,$5)',[foreignTenant,randomUUID(),kb.data.id,member(2),'foreign']),e=>e.code==='23503');
   await assert.rejects(()=>db.query('INSERT INTO acl_entry(tenant_id,id,kb_id,document_id,member_id,actions) VALUES($1,$2,$3,$4,$5,$6)',[tenant,randomUUID(),kb.data.id,inherited,member(1),['read']]),e=>e.code==='23514');
  });
  // Fixture ACLs model imported restricted documents. No public document creation before P1-04.
  for(const doc of [restricted,mismatch])await db.query('INSERT INTO acl_entry(tenant_id,id,document_id,member_id,actions) VALUES($1,$2,$3,$4,$5)',[tenant,randomUUID(),doc,member(3),doc===mismatch?['read','publish']:RESOURCE_ACTIONS]);
  await t.test('document ACL only narrows parent access; hidden and draft metadata do not leak',async()=>{
   assert.equal((await request(api,`/documents/${inherited}`,employee)).status,200);
   for(const doc of [restricted,draft,mismatch])assert.equal((await request(api,`/documents/${doc}`,employee)).status,404);
   const page=await (await request(api,`${endpoint}/documents?limit=1`,employee)).json();assert.deepEqual(page.data.map(d=>d.id),[inherited]);assert.equal(page.page.has_more,false);assert.ok(!JSON.stringify(page).includes('SENTINEL'));
   assert.equal((await request(api,`/documents/${inherited}`,other)).status,404);
   const aclResponse=await request(api,`/documents/${restricted}/acl`,operator);assert.equal(aclResponse.status,200);const docTag=aclResponse.headers.get('etag');
   const changed=await request(api,`/documents/${restricted}/acl`,operator,'PUT',{acl_mode:'restricted',grants:[owner,reader]},{'If-Match':docTag});assert.equal(changed.status,200,await failure(changed));
   assert.equal((await request(api,`/documents/${restricted}`,employee)).status,200);
   await assert.rejects(()=>secondPolicy.authorizeDocument(employee.identity,restricted,'write'),e=>e.status===404);
   const parentChange=await acl(api,operator,kb.data.id,[owner],kb.etag);assert.equal(parentChange.status,200);kb.etag=parentChange.headers.get('etag');
   assert.equal((await request(api,`/documents/${restricted}`,employee)).status,404);
   assert.equal((await request(api,`${endpoint}/documents`,employee)).status,404);
   const stale=await request(api,`/documents/${restricted}/acl`,operator,'PUT',{acl_mode:'inherit',grants:[]},{'If-Match':changed.headers.get('etag')});assert.equal(stale.status,412);
   // A document grant cannot expand access to a private parent KB.
   await db.query('INSERT INTO acl_entry(tenant_id,id,document_id,member_id,actions) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[tenant,randomUUID(),restricted,member(4),['read']]);
   assert.equal((await request(api,`/documents/${restricted}`,admin)).status,404);
  });
  await t.test('draft access requires the same editor action in parent and document ACLs',async()=>{
   await db.query('UPDATE acl_entry SET actions=$3 WHERE tenant_id=$1 AND kb_id=$2 AND member_id=$4',[tenant,kb.data.id,['read','write'],member(3)]);
   assert.equal((await request(api,`/documents/${mismatch}`,operator)).status,404);
   const response=await request(api,`${endpoint}/documents?q=MISMATCH_SENTINEL`,operator);assert.equal(response.status,200);assert.deepEqual((await response.json()).data,[]);
   await db.query('UPDATE acl_entry SET actions=$3 WHERE tenant_id=$1 AND kb_id=$2 AND member_id=$4',[tenant,kb.data.id,RESOURCE_ACTIONS,member(3)]);
  });
  await t.test('concurrent ACL updates cannot overwrite a newer policy',async()=>{
   const [a,b]=await Promise.all([acl(api,operator,kb.data.id,[owner],kb.etag),acl(api,operator,kb.data.id,[owner],kb.etag)]);
   assert.deepEqual([a.status,b.status].sort(),[200,412]);kb.etag=(a.ok?a:b).headers.get('etag');
  });
  await t.test('direct shared policy sees revocation and current membership without cached grants',async()=>{
   await assert.rejects(()=>policy.authorizeKnowledgeBase(employee.identity,kb.data.id,'read'),e=>e.status===404);
   await db.query("UPDATE membership SET status='disabled',authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2",[tenant,member(1)]);
   assert.equal((await request(api,'/auth/session',employee)).status,401);
   await assert.rejects(()=>secondPolicy.getKnowledgeBase(employee.identity,kb.data.id),e=>e.status===401);
   await db.query("UPDATE membership SET status='active',authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2",[tenant,member(1)]);
   assert.equal((await request(api,'/auth/session',employee)).status,401); // revoked Redis session does not resurrect.
  });
  await t.test('KB updates enforce versions, archive visibility and durable state after restart',async()=>{
   assert.equal((await request(api,endpoint,operator,'PATCH',{name:'new'})).status,428);
   const response=await request(api,endpoint,operator,'PATCH',{name:'归档制度',status:'archived'},{'If-Match':kb.etag});assert.equal(response.status,200,await failure(response));
   assert.equal((await request(api,endpoint,operator,'PATCH',{name:'stale'},{'If-Match':kb.etag})).status,412);
   assert.equal((await request(api,`/documents/${inherited}`,operator)).status,404);
   await api.stop();api=await start();const persisted=await request(api,endpoint,operator);assert.equal(persisted.status,200);assert.equal((await persisted.json()).data.name,'归档制度');
  });
  await t.test('self-revocation prevents idempotency replay from restoring access',async()=>{
   const value=await create(api,operator,'移交资料库');const adminGrant={principal_type:'member',principal_id:member(4),actions:[...RESOURCE_ACTIONS]};
   assert.equal((await acl(api,operator,value.data.id,[adminGrant],value.etag)).status,200);
   assert.equal((await request(api,`/knowledge-bases/${value.data.id}`,operator)).status,404);
   assert.equal((await request(api,'/knowledge-bases',operator,'POST',{name:'移交资料库'},{'Idempotency-Key':value.key})).status,404);
  });
  await t.test('PostgreSQL outage fails closed and audit contains only resource metadata',async()=>{
   const count=await db.query('SELECT * FROM resource_audit');assert.ok(count.rowCount>0);for(const row of count.rows){assert.ok(row.actor_id);assert.ok(row.request_id);assert.ok(!('description' in row));}
   const badUrl=new URL(process.env.DATABASE_URL);badUrl.port=String(await freePort());await api.stop();api=await start({DATABASE_URL:badUrl.toString()});
   assert.equal((await request(api,endpoint,operator)).status,503);
   assert.ok(!logs.includes(secret));assert.ok(!logs.includes('DRAFT_SENTINEL'));
  });
 }finally{
  await api?.stop();await policy?.close();await secondPolicy?.close();await db?.end();
  try{if(redis.status==='ready'){const keys=await redis.keys(`${prefix}*`);if(keys.length)await redis.del(...keys)}}finally{redis.disconnect()}
  if(adminDb){await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await adminDb.end()}
 }
});
