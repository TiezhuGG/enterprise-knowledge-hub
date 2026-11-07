import { STRUCTURE_PARSER_VERSION, type ParsedBlock, ParsedDocument, ParseWarning, SourceLocation, ParsedKind } from '@zhiheng/contracts';
export const PARSER_VERSION=STRUCTURE_PARSER_VERSION;
export interface ParserLimits {maxBytes:number;maxCharacters:number;maxBlocks:number;maxPages:number;maxOutputBytes:number;timeoutMs:number;heapMb:number;maxZipBytes:number;maxZipEntries:number}
export function parserLimits(env:NodeJS.ProcessEnv=process.env):ParserLimits {
 const n=(key:string,fallback:number,min:number,max:number)=>{const value=Number(env[key]??fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid ${key}`);return value};
 return {maxBytes:n('PARSER_MAX_BYTES',10485760,1,52428800),maxCharacters:n('PARSER_MAX_CHARACTERS',1000000,1,5000000),maxBlocks:n('PARSER_MAX_BLOCKS',10000,1,50000),maxPages:n('PARSER_MAX_PAGES',200,1,1000),maxOutputBytes:n('PARSER_MAX_OUTPUT_BYTES',5242880,1024,20971520),timeoutMs:n('PARSER_TIMEOUT_MS',30000,100,120000),heapMb:n('PARSER_HEAP_MB',256,64,512),maxZipBytes:n('PARSER_MAX_ZIP_BYTES',20971520,1024,104857600),maxZipEntries:n('PARSER_MAX_ZIP_ENTRIES',1000,1,5000)};
}
export class ParserFailure extends Error {constructor(readonly code:string){super(code)}}
export function reject(code:string):never{throw new ParserFailure(code)}
export class Builder {
 readonly blocks:ParsedBlock[]=[];readonly warnings:ParseWarning[]=[];readonly headings:string[]=[];characters=0;emptyPages=0;
 constructor(readonly limits:ParserLimits){}
 warn(code:string,severity:'info'|'review'='review',location:Pick<ParseWarning,'page'|'part'>={}){if(!this.warnings.some(w=>w.code===code&&w.page===location.page&&w.part===location.part))this.warnings.push({code,severity,...location})}
 add(kind:ParsedKind,text:string,source:SourceLocation,extra:Partial<ParsedBlock>={}){
  if(!text.trim()&&kind!=='table')return;
  this.characters+=text.length;if(this.characters>this.limits.maxCharacters)reject('PARSE_TEXT_LIMIT');if(this.blocks.length>=this.limits.maxBlocks)reject('PARSE_BLOCK_LIMIT');
  if(kind==='heading'){const level=extra.level??1;this.headings.length=level-1;this.headings[level-1]=text.slice(0,200);if(text.length>200)this.warn('HEADING_CONTEXT_TRUNCATED')}
  this.blocks.push({ordinal:this.blocks.length,kind,text,heading_path:this.headings.filter(Boolean),source,...extra});
 }
 finish(format:ParsedDocument['format'],sha:string,pages:number|null):ParsedDocument{
  if(!this.blocks.length||!this.characters)reject(format==='pdf'?'OCR_REQUIRED':'DOCUMENT_EMPTY');
  const replacements=this.blocks.reduce((count,block)=>count+(block.text.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008]/g)?.length??0),0);if(replacements)this.warn('TEXT_ENCODING_REVIEW_REQUIRED');
  if(replacements>20&&replacements/Math.max(1,this.characters)>.1)reject('TEXT_ENCODING_UNRELIABLE');
  return {parser_version:PARSER_VERSION,source_sha256:sha,format,page_count:pages,blocks:this.blocks,warnings:this.warnings,metrics:{characters:this.characters,blocks:this.blocks.length,tables:this.blocks.filter(b=>b.kind==='table').length,empty_pages:this.emptyPages,replacement_characters:replacements}};
 }
}
export function decodeText(bytes:Uint8Array){try{const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(value.includes('\0'))reject('TEXT_INVALID_UTF8');return value}catch(error){if(error instanceof ParserFailure)throw error;return reject('TEXT_INVALID_UTF8')}}
