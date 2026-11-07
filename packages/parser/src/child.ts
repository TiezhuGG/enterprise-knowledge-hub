import { createHash } from 'node:crypto';
import { Builder,ParserFailure,reject,type ParserLimits } from './common.js';
import { parseText,parseMarkdown } from './text.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';
console.log=()=>{};console.warn=()=>{};console.error=()=>{};
async function main(){
 let raw='';for await(const chunk of process.stdin){raw+=String(chunk);if(raw.length>75000000)reject('PARSE_INPUT_LIMIT')}
 const input=JSON.parse(raw) as {bytes:string;mime:string;limits:ParserLimits;parentPid:number};if(process.ppid!==input.parentPid)reject('PARSER_CANCELLED');const parentCheck=setInterval(()=>{if(process.ppid!==input.parentPid)process.exit(1)},250);parentCheck.unref();const bytes=Buffer.from(input.bytes,'base64'),b=new Builder(input.limits);
 if(bytes.length>input.limits.maxBytes)reject('PARSE_INPUT_LIMIT');const hash=createHash('sha256').update(bytes).digest('hex');let pages:number|null=null,format:'txt'|'markdown'|'pdf'|'docx';
 if(input.mime==='text/plain'){format='txt';parseText(bytes,b)}else if(input.mime==='text/markdown'){format='markdown';parseMarkdown(bytes,b)}else if(input.mime==='application/pdf'){format='pdf';pages=await parsePdf(bytes,b)}else if(input.mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'){format='docx';await parseDocx(bytes,b)}else reject('PARSER_FORMAT_UNSUPPORTED');
 const result=b.finish(format,hash,pages),json=JSON.stringify({ok:true,result});if(Buffer.byteLength(json)>input.limits.maxOutputBytes)reject('PARSE_OUTPUT_LIMIT');process.stdout.write(json);
}
main().catch(error=>{const code=error instanceof ParserFailure?error.code:'PARSER_FAILED';process.stdout.write(JSON.stringify({ok:false,code}))});
