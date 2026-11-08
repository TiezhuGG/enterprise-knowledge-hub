// Offline exporter helper. Never called by the API or synchronization worker.
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,basename,extname} from 'node:path';
import {createRequire} from 'node:module';
import {timingSafeEqual,randomUUID} from 'node:crypto';
const require=createRequire(new URL('../packages/resources/package.json',import.meta.url));
const {sourceBinding,DirectorySource,signSourceHead,sourceHash}=require('./dist');
const [ref,eventFile]=process.argv.slice(2);
if(!ref||process.argv.length>4){console.error('Usage: node --env-file=.env scripts/directory-feed.mjs <config_ref> [new-events.json]');process.exit(1)}
let temporary;
try{
 const config=JSON.parse(process.env.DIRECTORY_SOURCES_JSON??'{}')[ref];if(!config)throw new Error('SOURCE_NOT_CONFIGURED');
 const binding=await sourceBinding(ref,config.tenant_id,config.kb_id),source=new DirectorySource(binding),secret=process.env[binding.key_env];if(!secret||secret.length<32)throw new Error('SOURCE_AUTH_FAILED');
 // A single exporter process must serialize appends and renewals for each directory.
 let pages=[],end=0;
 try{const old=JSON.parse((await source.read('HEAD.json',65536)).toString());const expected=signSourceHead(old.payload,secret).signature;if(typeof old.signature!=='string'||!/^[a-f0-9]{64}$/.test(old.signature)||!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(old.signature,'hex'))||old.payload.source_id!==binding.source_id)throw new Error('SOURCE_AUTH_FAILED');pages=old.payload.pages;end=old.payload.end_seq;
  for(const page of pages)if(sourceHash(await source.read(page.file,2097152))!==page.sha256)throw new Error('SOURCE_HISTORY_CHANGED');
 }catch(e){try{await readFile(join(binding.root,'HEAD.json'));throw e}catch(missing){if(missing.code!=='ENOENT')throw e}}
 const events=eventFile?JSON.parse(await readFile(eventFile,'utf8')):[];if(!Array.isArray(events)||events.length>100)throw new Error('At most 100 new events per append');
 for(let i=0;i<events.length;i++){const e=events[i];if(e.seq!==undefined&&e.seq!==end+i+1)throw new Error('SOURCE_SEQUENCE_INVALID');e.seq=end+i+1;if(e.kind==='upsert'){const bytes=await source.read(e.file,52428800);e.size=bytes.length;e.sha256=sourceHash(bytes);e.filename??=basename(e.file);e.mime??=({'.md':'text/markdown','.txt':'text/plain','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})[extname(e.filename).toLowerCase()]??'application/octet-stream'}}
 if(events.length){if(pages.length>=50)throw new Error('SOURCE_PAGE_LIMIT');const bytes=Buffer.from(JSON.stringify(events)),file=`events-${end+1}-${end+events.length}-${sourceHash(bytes)}.json`;await writeFile(join(binding.root,file),bytes,{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e});pages=[...pages,{start_seq:end+1,end_seq:end+events.length,sha256:sourceHash(bytes),file}];end+=events.length}
 const issued=Date.now();const payload={schema:'directory-feed-v1',source_id:binding.source_id,issued_at:new Date(issued).toISOString(),valid_until:new Date(issued+binding.freshness_seconds*1000).toISOString(),end_seq:end,pages};
 // Validate the complete candidate, including event schema, before replacing HEAD.
 const candidate=Buffer.from(JSON.stringify(signSourceHead(payload,secret)));temporary=`HEAD-${randomUUID()}.tmp`;await writeFile(join(binding.root,temporary),candidate,{flag:'wx',mode:0o600});
 const original=source.read.bind(source);source.read=async(path,max)=>path==='HEAD.json'?candidate:original(path,max);await source.snapshot();
 await rename(join(binding.root,temporary),join(binding.root,'HEAD.json'));temporary=undefined;console.log(`Directory attestation saved; checkpoint ${end}.`);
}catch(e){console.error(e.code??e.message??'EXPORT_FAILED');process.exitCode=1}finally{if(temporary){const config=JSON.parse(process.env.DIRECTORY_SOURCES_JSON??'{}')[ref];await unlink(join(config.root,temporary)).catch(()=>{})}}
