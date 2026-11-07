import { fail } from './policy';
import { sha256 } from './objects';
export interface UploadInput {kb_id:string;document_id?:string;filename:string;size:number;mime:string;sha256:string}
export interface UploadLimits {maxBytes:number;tenantBytes:number;tickets:number;ttl:number}
export function uploadLimits(env:NodeJS.ProcessEnv=process.env):UploadLimits {
  function setting(name:string,fallback:number,max:number){const value=Number(env[name]??fallback);if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`Invalid ${name}`);return value}
  return {maxBytes:setting('UPLOAD_MAX_BYTES',10485760,52428800),tenantBytes:setting('UPLOAD_TENANT_BYTES',1073741824,1099511627776),tickets:setting('UPLOAD_ACTIVE_TICKETS',20,1000),ttl:setting('UPLOAD_TTL_SECONDS',600,3600)};
}
export function validateUpload(input:UploadInput,limits:UploadLimits){
  if(!input||typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>200||/[\\/\x00-\x1f\x7f]/.test(input.filename))fail(400,'INVALID_FILENAME');
  if(!Number.isSafeInteger(input.size)||input.size<1)fail(400,'INVALID_FILE_SIZE');
  if(input.size>limits.maxBytes)fail(413,'UPLOAD_TOO_LARGE');
  if(typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))fail(400,'INVALID_SHA256');
  const suffix=input.filename.toLowerCase().split('.').at(-1);
  if(!((suffix==='docx'&&input.mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document')||(suffix==='pdf'&&input.mime==='application/pdf')||(suffix==='txt'&&input.mime==='text/plain')||(suffix==='md'&&['text/markdown','text/plain'].includes(input.mime))))fail(415,'UNSUPPORTED_FILE_TYPE');
}
export function verifyBytes(bytes:Buffer,input:Pick<UploadInput,'size'|'mime'|'sha256'>){
  if(bytes.length!==input.size||sha256(bytes)!==input.sha256)fail(422,'CONTENT_MISMATCH');
  if(input.mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'){if(!bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04])))fail(415,'FILE_SIGNATURE_MISMATCH')}
  else if(input.mime==='application/pdf') {if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')fail(415,'FILE_SIGNATURE_MISMATCH')}
  else {
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{fail(415,'INVALID_UTF8')}
    if(bytes.includes(0)||bytes.subarray(0,5).toString('ascii')==='%PDF-'||bytes.subarray(0,2).toString('ascii')==='PK')fail(415,'FILE_SIGNATURE_MISMATCH');
  }
}
