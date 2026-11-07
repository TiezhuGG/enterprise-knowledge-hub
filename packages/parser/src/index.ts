import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
import type { ParsedDocument } from '@zhiheng/contracts';
import { PARSER_VERSION,ParserFailure,parserLimits,type ParserLimits } from './common.js';
export {PARSER_VERSION,ParserFailure,parserLimits};export type {ParserLimits};
/** No credentials are inherited. Process permissions only permit reading parser code/dependencies. */
export function parseIsolated(bytes:Buffer,mime:string,signal?:AbortSignal,limits:ParserLimits=parserLimits()):Promise<ParsedDocument>{
 if(bytes.length>limits.maxBytes)return Promise.reject(new ParserFailure('PARSE_INPUT_LIMIT'));
 if(signal?.aborted)return Promise.reject(new ParserFailure('PARSER_CANCELLED'));
 return new Promise((resolveResult,deny)=>{
  const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../../..');
  const command=process.platform==='linux'&&existsSync('/usr/bin/prlimit')?'/usr/bin/prlimit':process.execPath;
  const prefix=command===process.execPath?[]:[`--cpu=${Math.max(1,Math.ceil(limits.timeoutMs/1000))}`, '--',process.execPath];
  const child=spawn(command,[...prefix,`--max-old-space-size=${limits.heapMb}`,'--permission','--disallow-code-generation-from-strings','--allow-addons',`--allow-fs-read=${resolve(directory,'..')}`,`--allow-fs-read=${join(root,'node_modules')}`,`--allow-fs-read=${join(root,'package.json')}`,`--allow-fs-read=${join(root,'packages/contracts')}`,join(directory,'child.js')],{env:{NODE_ENV:'production',TZ:'UTC',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
  let output='',size=0,errorSize=0,resourceLimit=false,settled=false;
  const fail=(code:string)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill('SIGKILL');deny(new ParserFailure(code))};
  const abort=()=>fail('PARSER_CANCELLED');const timer=setTimeout(()=>fail('PARSE_TIMEOUT'),limits.timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  child.on('error',()=>fail('PARSER_START_FAILED'));child.stdin.on('error',()=>{});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>limits.maxOutputBytes){fail('PARSE_OUTPUT_LIMIT');return}output+=String(chunk)});
  child.stderr.on('data',chunk=>{errorSize+=Buffer.byteLength(chunk);if(String(chunk).includes('heap out of memory')||String(chunk).includes('Allocation failed'))resourceLimit=true;if(errorSize>32768)fail('PARSE_RESOURCE_LIMIT')});
  child.on('close',(code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(code!==0){deny(new ParserFailure(resourceLimit?'PARSE_RESOURCE_LIMIT':'PARSER_FAILED'));return}try{const value=JSON.parse(output);if(!value.ok){deny(new ParserFailure(typeof value.code==='string'?value.code:'PARSER_FAILED'));return}if(value.result?.parser_version!==PARSER_VERSION)throw new Error();resolveResult(value.result as ParsedDocument)}catch{deny(new ParserFailure('PARSER_INVALID_RESPONSE'))}});
  child.stdin.end(JSON.stringify({parentPid:process.pid,bytes:bytes.toString('base64'),mime,limits}));
 });
}
