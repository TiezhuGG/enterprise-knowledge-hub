import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RESOURCE_ACTIONS, type IdentityContext, type ResourceAction, type ResourceGrant, type KnowledgeBase, type KnowledgeDocument, type ResourcePage } from '@zhiheng/contracts';
import { databasePool, transaction } from './database';
import { allowedActions, fail, ROLE_ACTIONS } from './policy';

export interface ListInput { limit: number; q: string; status?: string; cursor?: string }
export interface KnowledgeInput { name: string; description: string; publish_policy: 'manual' }
export const kbEtag = (kb: { id: string; row_version: number }) => `"kb:${kb.id}:${kb.row_version}"`;
export const docEtag = (doc: { id: string; row_version: number; kb_policy_version: number }) => `"doc:${doc.id}:${doc.row_version}:${doc.kb_policy_version}"`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const manages = ['manage', 'manage_acl'];
const principal = `(a.member_id=$2 OR EXISTS (SELECT 1 FROM group_member gm WHERE gm.tenant_id=a.tenant_id AND gm.group_id=a.group_id AND gm.member_id=$2))`;
// Same tenant/principal/role predicate used by direct reads and pre-pagination filtering.
export const kbCaps = `(SELECT array_agg(DISTINCT action) FROM acl_entry a CROSS JOIN LATERAL unnest(a.actions) action WHERE a.tenant_id=k.tenant_id AND a.kb_id=k.id AND ${principal} AND action=ANY($3::text[]))`;
export const docCaps = `(SELECT array_agg(DISTINCT action) FROM acl_entry a CROSS JOIN LATERAL unnest(a.actions) action WHERE a.tenant_id=d.tenant_id AND a.document_id=d.id AND ${principal} AND action=ANY($3::text[]))`;

export class ResourceStore {
  protected readonly pool;
  constructor(url?: string, schema = 'public', protected readonly cursorSecret = '') { this.pool = databasePool(url, schema); }
  close() { return this.pool?.end(); }
  async identity(input: IdentityContext) { return transaction(this.pool, client => this.member(client, input)); }
  protected async member(client: PoolClient, input: IdentityContext): Promise<IdentityContext & { authz_version: number }> {
    const result = await client.query(`SELECT m.* FROM membership m JOIN tenant t ON t.id=m.tenant_id
      WHERE m.tenant_id=$1 AND m.id=$2 AND m.actor_id=$3 AND m.status='active' AND t.status='active' FOR SHARE OF m,t`, [input.tenant_id, input.membership_id, input.actor_id]);
    const row = result.rows[0]; if (!row) fail(401, 'MEMBERSHIP_INACTIVE');
    return { actor_id: row.actor_id, tenant_id: row.tenant_id, membership_id: row.id, role: row.role,
      provider: input.provider, capabilities: row.can_create_kb || row.role === 'admin' ? ['knowledge:read', 'knowledge:create'] : ['knowledge:read'], authz_version: row.authz_version };
  }
  protected async run<T>(input: IdentityContext, fn: (client: PoolClient, member: IdentityContext & { authz_version: number }) => Promise<T>) {
    return transaction(this.pool, async client => fn(client, await this.member(client, input)));
  }
  private params(member: IdentityContext) { return [member.tenant_id, member.membership_id, ROLE_ACTIONS[member.role]]; }
  private kbView(row: any, member: IdentityContext): KnowledgeBase {
    let capabilities = allowedActions(member, row.caps ?? []);
    if (row.status === 'archived') capabilities = capabilities.filter(action => manages.includes(action));
    return { id: row.id, name: row.name, description: row.description, publish_policy: row.publish_policy,
      status: row.status, row_version: row.row_version, policy_version: row.policy_version,
      created_at: row.created_at.toISOString(), capabilities };
  }
  protected async kb(client: PoolClient, member: IdentityContext, id: string, action?: ResourceAction, lock = false) {
    const result = await client.query(`SELECT k.*, ${kbCaps} AS caps FROM knowledge_base k WHERE k.tenant_id=$1 AND k.id=$4 AND k.status<>'deleted' ${lock ? 'FOR UPDATE OF k' : 'FOR SHARE OF k'}`, [...this.params(member), id]);
    const row = result.rows[0]; if (!row) fail(404, 'RESOURCE_UNAVAILABLE');
    const view = this.kbView(row, member);
    if (action ? !view.capabilities.includes(action) : !view.capabilities.some(a => ['read', 'manage', 'manage_acl'].includes(a))) fail(404, 'RESOURCE_UNAVAILABLE');
    return view;
  }
  private match(actual: string, expected?: string) {
    if (!expected) fail(428, 'IF_MATCH_REQUIRED');
    if (expected !== actual) fail(412, 'RESOURCE_VERSION_CHANGED');
  }
  protected async audit(client: PoolClient, member: IdentityContext, id: string, action: string, requestId: string) {
    await client.query('INSERT INTO resource_audit(id,tenant_id,actor_id,member_id,resource_id,action,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(),member.tenant_id,member.actor_id,member.membership_id,id,action,requestId]);
  }
  getKnowledgeBase(member: IdentityContext, id: string) { return this.run(member, (client, current) => this.kb(client, current, id)); }
  /** Trusted callers including future workers/retrieval must pass original actor identity, never cached role grants. */
  authorizeKnowledgeBase(member: IdentityContext, id: string, action: ResourceAction) {
    return this.run(member, (client, current) => this.kb(client, current, id, action));
  }
  protected scope(member: IdentityContext & { authz_version: number }, input: ListInput, kind: string) {
    return hash(JSON.stringify([member.tenant_id, member.membership_id, member.authz_version, member.role, kind, input.q, input.status ?? '', input.limit]));
  }
  protected cursor(input: ListInput, scope: string): [string, string] | null {
    if (this.cursorSecret.length < 32) fail(503, 'CURSOR_SECRET_REQUIRED');
    if (!input.cursor) return null;
    try {
      const [payload, signature, extra] = input.cursor.split('.');
      if (!payload || !signature || extra) fail(400, 'INVALID_CURSOR');
      const expected = createHmac('sha256', this.cursorSecret).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(400, 'INVALID_CURSOR');
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (data.scope !== scope || !/^[0-9a-f-]{36}$/.test(data.id) || !Number.isFinite(Date.parse(data.at))) fail(400, 'INVALID_CURSOR');
      return [data.at, data.id];
    } catch { fail(400, 'INVALID_CURSOR'); }
  }
  protected page<T extends { id: string; created_at: string }>(rows: T[], input: ListInput, scope: string): ResourcePage<T> {
    const hasMore = rows.length > input.limit; const data = rows.slice(0,input.limit); const last = data.at(-1);
    let cursor: string | null = null;
    if (hasMore && last) {
      const payload = Buffer.from(JSON.stringify({ scope, id: last.id, at: last.created_at })).toString('base64url');
      cursor = `${payload}.${createHmac('sha256',this.cursorSecret).update(payload).digest('base64url')}`;
    }
    return { data, page: { next_cursor: cursor, has_more: hasMore } };
  }
  listKnowledgeBases(member: IdentityContext, input: ListInput) {
    return this.run(member, async (client,current) => {
      const scope = this.scope(current,input,'kb'); const after = this.cursor(input,scope);
      const result = await client.query(`SELECT * FROM (SELECT k.*, ${kbCaps} AS caps FROM knowledge_base k WHERE k.tenant_id=$1 AND k.status<>'deleted') visible
        WHERE caps && CASE WHEN status='archived' THEN ARRAY['manage','manage_acl'] ELSE ARRAY['read','manage','manage_acl'] END::text[]
        AND ($4::text IS NULL OR status=$4) AND position(lower($5) in lower(name))>0
        AND ($6::timestamptz IS NULL OR (created_at,id)<($6,$7::uuid)) ORDER BY created_at DESC,id DESC LIMIT $8`, [...this.params(current),input.status ?? null,input.q,after?.[0] ?? null,after?.[1] ?? null,input.limit+1]);
      return this.page(result.rows.map(row => this.kbView(row,current)),input,scope);
    });
  }
  createKnowledgeBase(member: IdentityContext, input: KnowledgeInput, key: string, requestId: string) {
    return this.run(member, async (client,current) => {
      if (!current.capabilities.includes('knowledge:create') || !ROLE_ACTIONS[current.role].includes('manage_acl')) fail(403,'CREATE_NOT_ALLOWED');
      const keyHash=hash(key), payloadHash=hash(JSON.stringify(input));
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${current.tenant_id}:${current.membership_id}:${keyHash}`]);
      const old=await client.query('SELECT * FROM resource_idempotency WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3 AND expires_at>now()',[current.tenant_id,current.membership_id,keyHash]);
      if (old.rowCount) {
        if (old.rows[0].payload_hash!==payloadHash) fail(409,'IDEMPOTENCY_KEY_REUSED');
        return this.kb(client,current,old.rows[0].kb_id,'manage');
      }
      await client.query('DELETE FROM resource_idempotency WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3',[current.tenant_id,current.membership_id,keyHash]);
      const id=randomUUID();
      await client.query('INSERT INTO knowledge_base(tenant_id,id,owner_id,name,description,publish_policy) VALUES($1,$2,$3,$4,$5,$6)',[current.tenant_id,id,current.membership_id,input.name,input.description,input.publish_policy]);
      await client.query('INSERT INTO acl_entry(tenant_id,id,kb_id,member_id,actions) VALUES($1,$2,$3,$4,$5)',[current.tenant_id,randomUUID(),id,current.membership_id,RESOURCE_ACTIONS]);
      await client.query('INSERT INTO resource_idempotency(tenant_id,member_id,key_hash,payload_hash,kb_id) VALUES($1,$2,$3,$4,$5)',[current.tenant_id,current.membership_id,keyHash,payloadHash,id]);
      await this.audit(client,current,id,'knowledge_base.created',requestId);
      return this.kb(client,current,id);
    });
  }
  updateKnowledgeBase(member: IdentityContext,id: string,input: Partial<KnowledgeInput> & {status?: 'active'|'archived'},etag: string|undefined,requestId: string) {
    return this.run(member,async(client,current)=>{
      const kb=await this.kb(client,current,id,'manage',true); this.match(kbEtag(kb),etag);
      await client.query('UPDATE knowledge_base SET name=$3,description=$4,status=$5,publish_policy=$6,row_version=row_version+1,policy_version=policy_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',[current.tenant_id,id,input.name??kb.name,input.description??kb.description,input.status??kb.status,input.publish_policy??kb.publish_policy]);
      await this.audit(client,current,id,'knowledge_base.updated',requestId); return this.kb(client,current,id);
    });
  }
  private async grants(client: PoolClient,tenant: string,id: string,kind:'kb'|'document'): Promise<ResourceGrant[]> {
    const result=await client.query(`SELECT member_id,group_id,actions FROM acl_entry WHERE tenant_id=$1 AND ${kind==='kb'?'kb_id':'document_id'}=$2 ORDER BY COALESCE(member_id,group_id)`,[tenant,id]);
    return result.rows.map(row=>({principal_type:row.member_id?'member':'group',principal_id:row.member_id??row.group_id,actions:row.actions}));
  }
  private async validateGrants(client:PoolClient,current:IdentityContext,grants:ResourceGrant[],kbId?:string) {
    const managers=new Set<string>();
    for(const grant of grants) {
      const rows=grant.principal_type==='member'
        ? await client.query("SELECT * FROM membership WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",[current.tenant_id,grant.principal_id])
        : await client.query('SELECT id FROM workspace_group WHERE tenant_id=$1 AND id=$2 FOR SHARE',[current.tenant_id,grant.principal_id]);
      if(!rows.rowCount) fail(400,'INVALID_GRANT_PRINCIPAL');
      if(grant.actions.includes('manage_acl') && grant.actions.includes('manage') && (!kbId || grant.actions.includes('read'))) {
        const members=grant.principal_type==='member'?rows:await client.query("SELECT m.* FROM membership m JOIN group_member gm ON gm.tenant_id=m.tenant_id AND gm.member_id=m.id WHERE gm.tenant_id=$1 AND gm.group_id=$2 AND m.status='active' FOR SHARE OF m",[current.tenant_id,grant.principal_id]);
        for(const m of members.rows) if(['admin','operator'].includes(m.role)) managers.add(m.id);
      }
    }
    if(kbId) {
      for(const id of [...managers]) {
        const row=await client.query('SELECT * FROM membership WHERE tenant_id=$1 AND id=$2',[current.tenant_id,id]);
        const m=row.rows[0];
        const permissions=await client.query(`SELECT ${kbCaps} AS caps FROM knowledge_base k WHERE k.tenant_id=$1 AND k.id=$4`,[current.tenant_id,m.id,ROLE_ACTIONS[m.role as keyof typeof ROLE_ACTIONS],kbId]);
        if(!['read','manage','manage_acl'].every(action=>(permissions.rows[0]?.caps??[]).includes(action))) managers.delete(id);
      }
    }
    if(!managers.size) fail(409,'LAST_RESOURCE_MANAGER');
  }
  private async replaceGrants(client:PoolClient,current:IdentityContext,id:string,kind:'kb'|'document',grants:ResourceGrant[]) {
    await client.query(`DELETE FROM acl_entry WHERE tenant_id=$1 AND ${kind==='kb'?'kb_id':'document_id'}=$2`,[current.tenant_id,id]);
    for(const grant of grants) await client.query(`INSERT INTO acl_entry(tenant_id,id,${kind==='kb'?'kb_id':'document_id'},member_id,group_id,actions) VALUES($1,$2,$3,$4,$5,$6)`,[current.tenant_id,randomUUID(),id,grant.principal_type==='member'?grant.principal_id:null,grant.principal_type==='group'?grant.principal_id:null,grant.actions]);
  }
  getKnowledgeAcl(member:IdentityContext,id:string) { return this.run(member,async(client,current)=>{
    const kb=await this.kb(client,current,id,'manage_acl'); return {grants:await this.grants(client,current.tenant_id,id,'kb'),policy_version:kb.policy_version,etag:kbEtag(kb)};
  }); }
  setKnowledgeAcl(member:IdentityContext,id:string,grants:ResourceGrant[],etag:string|undefined,requestId:string) { return this.run(member,async(client,current)=>{
    const kb=await this.kb(client,current,id,'manage_acl',true); this.match(kbEtag(kb),etag);
    await this.validateGrants(client,current,grants); await this.replaceGrants(client,current,id,'kb',grants);
    await client.query('UPDATE knowledge_base SET row_version=row_version+1,policy_version=policy_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',[current.tenant_id,id]);
    await this.audit(client,current,id,'knowledge_base.acl_changed',requestId);
    return {grants,policy_version:kb.policy_version+1,etag:kbEtag({...kb,row_version:kb.row_version+1})};
  }); }
  private documentView(row:any,current:IdentityContext): KnowledgeDocument & {kb_policy_version:number} {
    let capabilities=allowedActions(current,row.kb_caps??[]);
    if(row.acl_mode==='restricted') capabilities=capabilities.filter(a=>(row.doc_caps??[]).includes(a));
    if(!capabilities.includes('read') || row.kb_status!=='active' || row.status==='deleted') capabilities=[];
    if(row.status!=='active' && !capabilities.some(a=>['write','publish','manage'].includes(a))) capabilities=[];
    return {id:row.id,kb_id:row.kb_id,title:row.title,status:row.status,acl_mode:row.acl_mode,row_version:row.row_version,policy_version:row.policy_version,kb_policy_version:row.kb_policy_version,created_at:row.created_at.toISOString(),capabilities};
  }
  protected async doc(client:PoolClient,current:IdentityContext,id:string,action:ResourceAction='read',lock=false) {
    const location=await client.query('SELECT kb_id FROM document WHERE tenant_id=$1 AND id=$2',[current.tenant_id,id]);
    if(!location.rows[0])fail(404,'RESOURCE_UNAVAILABLE');
    await this.kb(client,current,location.rows[0].kb_id,undefined,lock);
    const result=await client.query(`SELECT d.*,k.status AS kb_status,k.policy_version AS kb_policy_version,${kbCaps} AS kb_caps,${docCaps} AS doc_caps FROM document d JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id WHERE d.tenant_id=$1 AND d.id=$4 AND k.status<>'deleted' ${lock?'FOR UPDATE OF d':'FOR SHARE OF d'}`,[...this.params(current),id]);
    const row=result.rows[0]; if(!row) fail(404,'RESOURCE_UNAVAILABLE');
    const view=this.documentView(row,current); if(!view.capabilities.includes(action)) fail(404,'RESOURCE_UNAVAILABLE'); return view;
  }
  getDocument(member:IdentityContext,id:string) { return this.run(member,(client,current)=>this.doc(client,current,id)); }
  authorizeDocument(member:IdentityContext,id:string,action:ResourceAction) { return this.run(member,(client,current)=>this.doc(client,current,id,action)); }
  listDocuments(member:IdentityContext,kbId:string,input:ListInput) { return this.run(member,async(client,current)=>{
    await this.kb(client,current,kbId,'read');
    const scope=this.scope(current,input,`documents:${kbId}`),after=this.cursor(input,scope);
    const result=await client.query(`SELECT * FROM (SELECT *,CASE WHEN acl_mode='inherit' THEN kb_caps ELSE ARRAY(SELECT unnest(kb_caps) INTERSECT SELECT unnest(doc_caps)) END AS effective_caps FROM (SELECT d.*,k.status AS kb_status,k.policy_version AS kb_policy_version,${kbCaps} AS kb_caps,${docCaps} AS doc_caps FROM document d JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id WHERE d.tenant_id=$1 AND d.kb_id=$4 AND d.status<>'deleted') raw) visible
      WHERE 'read'=ANY(effective_caps) AND kb_status='active'
      AND (status='active' OR effective_caps && ARRAY['write','publish','manage']::text[])
      AND ($5::text IS NULL OR status=$5) AND position(lower($6) in lower(title))>0
      AND ($7::timestamptz IS NULL OR (created_at,id)<($7,$8::uuid)) ORDER BY created_at DESC,id DESC LIMIT $9`,[...this.params(current),kbId,input.status??null,input.q,after?.[0]??null,after?.[1]??null,input.limit+1]);
    return this.page(result.rows.map(row=>this.documentView(row,current)),input,scope);
  }); }
  getDocumentAcl(member:IdentityContext,id:string) { return this.run(member,async(client,current)=>{
    const doc=await this.doc(client,current,id,'manage_acl'); await this.kb(client,current,doc.kb_id,'manage_acl');
    return {acl_mode:doc.acl_mode,grants:await this.grants(client,current.tenant_id,id,'document'),policy_version:doc.policy_version,etag:docEtag(doc)};
  }); }
  setDocumentAcl(member:IdentityContext,id:string,mode:'inherit'|'restricted',grants:ResourceGrant[],etag:string|undefined,requestId:string) { return this.run(member,async(client,current)=>{
    const doc=await this.doc(client,current,id,'manage_acl',true); await this.kb(client,current,doc.kb_id,'manage_acl'); this.match(docEtag(doc),etag);
    if(mode==='restricted') await this.validateGrants(client,current,grants,doc.kb_id);
    await this.replaceGrants(client,current,id,'document',grants);
    await client.query('UPDATE document SET acl_mode=$3,row_version=row_version+1,policy_version=policy_version+1 WHERE tenant_id=$1 AND id=$2',[current.tenant_id,id,mode]);
    await this.audit(client,current,id,'document.acl_changed',requestId);
    return {acl_mode:mode,grants,policy_version:doc.policy_version+1,etag:docEtag({...doc,row_version:doc.row_version+1})};
  }); }
}
