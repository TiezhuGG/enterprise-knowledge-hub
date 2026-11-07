const { databasePool, transaction } = require('../dist');
if (!['development','test'].includes(process.env.NODE_ENV)) { console.error('Development seed is disabled outside development/test'); process.exit(1); }
const pool=databasePool(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA);
transaction(pool,async client=>{
  for(const suffix of ['1','2']) await client.query('INSERT INTO tenant(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[`20000000-0000-4000-8000-00000000000${suffix}`,suffix==='1'?'开发工作空间':'隔离测试空间']);
  for(const [n,tenant,role,create] of [['1','1','employee',false],['2','2','employee',false],['3','1','operator',true],['4','1','admin',true]]) await client.query('INSERT INTO membership(tenant_id,id,actor_id,role,can_create_kb) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[
    `20000000-0000-4000-8000-00000000000${tenant}`,`30000000-0000-4000-8000-00000000000${n}`,`10000000-0000-4000-8000-00000000000${n}`,role,create]);
}).then(()=>console.log('Development identities seeded; existing membership changes preserved')).catch(()=>{console.error('Development seed failed; run migrations and check configuration');process.exitCode=1}).finally(()=>pool?.end());
