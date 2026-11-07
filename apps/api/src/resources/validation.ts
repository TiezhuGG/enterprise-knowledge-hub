import {hybridOptions,rerankOptions,contextOptions} from '@zhiheng/resources';
import { RESOURCE_ACTIONS, type ResourceGrant } from '@zhiheng/contracts';
import { fail, type KnowledgeInput, type ListInput } from '@zhiheng/resources';
export function object(value: unknown, allowed: readonly string[]): Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) fail(400,'INVALID_FIELDS');
  return value as Record<string,unknown>;
}
export function id(value: unknown): string {
  if (typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(400,'INVALID_ID'); return value.toLowerCase();
}
function text(value:unknown,max:number,empty=false) { if(typeof value!=='string'||value.trim().length>max||(!empty&&!value.trim())) fail(400,'INVALID_TEXT'); return value.trim(); }
export function knowledgeInput(value:unknown,patch=false): Partial<KnowledgeInput>&{status?:'active'|'archived'} {
  const body=object(value,patch?['name','description','publish_policy','status']:['name','description','publish_policy']);
  if(patch&&!Object.keys(body).length) fail(400,'EMPTY_UPDATE');
  const result:Partial<KnowledgeInput>&{status?:'active'|'archived'}={};
  if(body.name!==undefined||!patch) result.name=text(body.name,100);
  if(body.description!==undefined||!patch) result.description=text(body.description??'',2000,true);
  if(body.publish_policy!==undefined||!patch) { if((body.publish_policy??'manual')!=='manual') fail(400,'UNSUPPORTED_PUBLISH_POLICY'); result.publish_policy='manual'; }
  if(body.status!==undefined) { if(body.status!=='active'&&body.status!=='archived') fail(400,'INVALID_STATUS'); result.status=body.status; }
  return result;
}
export function listInput(query:unknown,document=false):ListInput {
  const q=object(query,['q','status','cursor','limit']);
  const limit=q.limit===undefined?20:Number(q.limit);
  if((q.limit!==undefined&&typeof q.limit!=='string')||!Number.isInteger(limit)||limit<1||limit>100) fail(400,'INVALID_LIMIT');
  if(q.status!==undefined&&!(document?['draft','active','archived']:['active','archived']).includes(q.status as string)) fail(400,'INVALID_STATUS');
  if(q.cursor!==undefined&&(typeof q.cursor!=='string'||q.cursor.length>2048)) fail(400,'INVALID_CURSOR');
  return {limit,q:q.q===undefined?'':text(q.q,120,true),status:q.status as string|undefined,cursor:q.cursor as string|undefined};
}
export function grantInput(value:unknown,document=false):{grants:ResourceGrant[];acl_mode?:'inherit'|'restricted'} {
  const body=object(value,document?['grants','acl_mode']:['grants']);
  if(!Array.isArray(body.grants)||body.grants.length>100) fail(400,'INVALID_GRANTS');
  const seen=new Set<string>();
  const grants:ResourceGrant[]=body.grants.map(raw=>{
    const g=object(raw,['principal_type','principal_id','actions']);
    if(g.principal_type!=='member'&&g.principal_type!=='group') fail(400,'INVALID_PRINCIPAL_TYPE');
    const principalId=id(g.principal_id),key=`${g.principal_type}:${principalId}`;
    if(seen.has(key)) fail(400,'DUPLICATE_GRANT'); seen.add(key);
    if(!Array.isArray(g.actions)||!g.actions.length||g.actions.some(a=>!RESOURCE_ACTIONS.includes(a))||new Set(g.actions).size!==g.actions.length) fail(400,'INVALID_ACTIONS');
    return {principal_type:g.principal_type,principal_id:principalId,actions:g.actions};
  });
  if(document&&(body.acl_mode!=='inherit'&&body.acl_mode!=='restricted')) fail(400,'INVALID_ACL_MODE');
  if(body.acl_mode==='inherit'&&grants.length) fail(400,'INHERITED_ACL_HAS_GRANTS');
  return {grants,acl_mode:body.acl_mode as 'inherit'|'restricted'|undefined};
}

export function searchInput(raw:unknown):import('@zhiheng/contracts').SearchInput{
  const b=object(raw,['query','kb_ids','top_k','mode','min_score','max_characters','hybrid','rerank','context']);if(typeof b.query!=='string'||!b.query.trim()||b.query.trim().length>1200)fail(400,'INVALID_QUERY');if(b.mode!==undefined&&!['dense','lexical','hybrid'].includes(b.mode as string))fail(400,'UNSUPPORTED_SEARCH_MODE');
  const integer=(v:unknown,d:number,min:number,max:number)=>{const n=v===undefined?d:v;if(typeof n!=='number'||!Number.isInteger(n)||n<min||n>max)fail(400,'INVALID_SEARCH_LIMIT');return n};let kbs:string[]|undefined;
  if(b.kb_ids!==undefined){if(!Array.isArray(b.kb_ids)||!b.kb_ids.length||b.kb_ids.length>10)fail(400,'INVALID_KB_SCOPE');kbs=[...new Set(b.kb_ids.map(id))]}
  if(b.hybrid!==undefined&&b.mode!=='hybrid')fail(400,'UNEXPECTED_HYBRID_OPTIONS');if(b.mode==='hybrid'&&b.min_score!==undefined)fail(400,'HYBRID_USE_CHANNEL_THRESHOLDS');
  if(b.rerank!==undefined&&b.mode!=='hybrid')fail(400,'RERANK_REQUIRES_HYBRID');
  const rerank=b.rerank===undefined?undefined:rerankOptions(b.rerank as Parameters<typeof rerankOptions>[0]),context=b.context===undefined?undefined:contextOptions(b.context as Parameters<typeof contextOptions>[0]);
  const hybrid=b.mode==='hybrid'?hybridOptions(b.hybrid as Parameters<typeof hybridOptions>[0]):undefined;
  const lexical=b.mode==='lexical';const min=b.min_score===undefined?(lexical?0:0.25):b.min_score;if(typeof min!=='number'||!Number.isFinite(min)||min<(lexical?0:-1)||min>(lexical?1000000:1))fail(400,'INVALID_MIN_SCORE');
  return {query:b.query.trim(),kb_ids:kbs,top_k:integer(b.top_k,5,1,20),mode:b.mode==='hybrid'?'hybrid':lexical?'lexical':'dense',min_score:min,...(rerank?{rerank}:{}),...(context?{context}:{}),...(hybrid?{hybrid}:{} ),max_characters:integer(b.max_characters,6000,500,16000)};
}
