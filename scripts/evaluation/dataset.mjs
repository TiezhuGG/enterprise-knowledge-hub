import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function checkDataset(data){
 if(data?.schema!=='baseline-dataset-v1'||data.provenance!=='repository-authored-fictional'||!Array.isArray(data.documents)||!data.documents.length||!Array.isArray(data.cases)||!data.cases.length)throw new Error('INVALID_DATASET');
 const docs=new Map(),questions=new Set();
 for(const d of data.documents){if(!/^[a-z][a-z0-9_]{0,49}$/.test(d.id)||docs.has(d.id)||!['published','draft','pending','rejected','archived','restricted'].includes(d.state)||typeof d.text!=='string'||sha256(d.text)!==d.sha256||!d.kb||!d.filename.endsWith('.md'))throw new Error('INVALID_CORPUS');docs.set(d.id,d)}
 const visible=(q,d)=>q.actor!=='other'&&(q.scope.length===0||q.scope.includes(d.kb))&&['published','restricted'].includes(d.state)&&(q.actor==='operator'||(d.kb!=='private'&&d.state!=='restricted'));
 for(const q of data.cases){if(!/^[A-Z]\d{2}$/.test(q.id)||questions.has(q.id)||typeof q.question!=='string'||!q.question.trim()||q.question.length>1200||!['employee','operator','other'].includes(q.actor)||!['answered','refused','conflict'].includes(q.expected)||!['answerable','unanswerable','permission','conflict','injection'].includes(q.category)||!Array.isArray(q.scope)||q.scope.some(k=>!data.documents.some(d=>d.kb===k))||!Array.isArray(q.required)||!Array.isArray(q.forbidden))throw new Error('INVALID_CASE');questions.add(q.id);
  if((q.expected==='refused')!==(q.required.length===0))throw new Error('INVALID_REFERENCE_DENOMINATOR');
  for(const group of q.required){if(!Array.isArray(group)||!group.length)throw new Error('INVALID_REFERENCE');for(const ref of group){const d=docs.get(ref.doc);if(!d||typeof ref.quote!=='string'||ref.quote.trim().length<4||!d.text.includes(ref.source_quote??ref.quote)||!visible(q,d)||q.forbidden.includes(d.id))throw new Error('INVALID_REFERENCE')}}
  for(const id of q.forbidden){const d=docs.get(id);if(!d||visible(q,d))throw new Error('INVALID_FORBIDDEN_REFERENCE')}
 }
 for(const p of data.probes??[])if(!/^P\d{2}$/.test(p.id)||questions.has(p.id)||!questions.has(p.case_id)||!['top_k','max_characters','fixture_behavior'].includes(p.variable)||typeof p.hypothesis!=='string')throw new Error('INVALID_PROBE');else questions.add(p.id);
 return data;
}
export async function loadDataset(directory=new URL('../../evals/baseline-v1/',import.meta.url)){
 const raw=await readFile(new URL('dataset.json',directory)),lock=JSON.parse(await readFile(new URL('dataset.lock.json',directory),'utf8'));
 if(lock.schema!=='baseline-lock-v1'||sha256(raw)!==lock.dataset_sha256)throw new Error('DATASET_LOCK_MISMATCH');return {data:checkDataset(JSON.parse(raw)),sha256:lock.dataset_sha256,raw};
}
export function observationDigest(row){const {digest,...value}=row;return sha256(JSON.stringify(value))}
