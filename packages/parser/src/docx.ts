import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ParsedCell,SourceLocation } from '@zhiheng/contracts';
import { Builder,ParserFailure,reject } from './common.js';
type X=Record<string,any>;
const tag=(node:X)=>Object.keys(node).find(key=>key!==':@'&&key!=='#text')??'';
const kids=(node:X):X[]=>Array.isArray(node[tag(node)])?node[tag(node)]:[];
const attr=(node:X,key:string)=>node[':@']?.[`@_${key}`];
function find(nodes:X[],name:string):X[]{const result:X[]=[];const stack=[...nodes];let visited=0;while(stack.length){if(++visited>200000)reject('PARSE_RESOURCE_LIMIT');const n=stack.pop()!;if(tag(n)===name)result.push(n);stack.push(...kids(n))}return result.reverse()}
function xml(value:Buffer):X[]{const text=value.toString('utf8');if(/<!DOCTYPE|<!ENTITY/i.test(text))reject('DOCX_UNSAFE_XML');if(XMLValidator.validate(text)!==true)reject('DOCX_DAMAGED');return new XMLParser({preserveOrder:true,ignoreAttributes:false,trimValues:false,parseTagValue:false,processEntities:false}).parse(text) as X[]}
async function archive(bytes:Uint8Array,b:Builder){return new Promise<Map<string,Buffer>>((resolve,deny)=>{
 yauzl.fromBuffer(Buffer.from(bytes),{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>{
  if(error||!zip){deny(new ParserFailure('DOCX_DAMAGED'));return}const files=new Map<string,Buffer>();let count=0,total=0,done=false;
  const fail=(code:string)=>{if(done)return;done=true;zip.close();deny(new ParserFailure(code))};zip.on('error',()=>fail('DOCX_DAMAGED'));
  zip.on('entry',entry=>{
   if(++count>b.limits.maxZipEntries){fail('DOCX_ZIP_LIMIT');return}
   if(entry.fileName.startsWith('/')||entry.fileName.includes('\\')||entry.fileName.split('/').includes('..')){fail('DOCX_DAMAGED');return}
   if(entry.generalPurposeBitFlag&1){fail('DOCX_ENCRYPTED');return}
   if(/vbaProject\.bin$/i.test(entry.fileName)){fail('DOCX_MACRO_UNSUPPORTED');return}
   total+=entry.uncompressedSize;if(total>b.limits.maxZipBytes||(entry.uncompressedSize>1048576&&entry.uncompressedSize>Math.max(1,entry.compressedSize)*200)){fail('DOCX_ZIP_LIMIT');return}
   if(!(/^(\[Content_Types\]\.xml|word\/(document|styles|header\d+|footer\d+)\.xml|word\/_rels\/document\.xml\.rels)$/.test(entry.fileName))){zip.readEntry();return}
   zip.openReadStream(entry,(err,stream)=>{if(err||!stream){fail('DOCX_DAMAGED');return}const chunks:Buffer[]=[];let length=0;stream.on('data',chunk=>{length+=chunk.length;if(length>entry.uncompressedSize||length>b.limits.maxZipBytes){stream.destroy();fail('DOCX_ZIP_LIMIT')}else chunks.push(Buffer.from(chunk))});stream.on('error',()=>fail('DOCX_DAMAGED'));stream.on('end',()=>{if(done)return;files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry()})});
  });zip.on('end',()=>{if(!done){done=true;resolve(files)}});zip.readEntry();
 });
})}
const enabled=(node:X)=>!['0','false','off'].includes(String(attr(node,'w:val')??'true').toLowerCase());
function decoded(value:string){return value.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi,(_,key:string)=>{const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'\"',apos:"'"};if(named[key])return named[key];const n=key[1]?.toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));if(!Number.isInteger(n)||n<1||n>0x10ffff||(n>=0xd800&&n<=0xdfff))reject('DOCX_DAMAGED');return String.fromCodePoint(n)})}
function text(nodes:X[],b:Builder,part:string,depth=0):string{
 if(depth>100)reject('PARSE_RESOURCE_LIMIT');return nodes.map(node=>{
  const name=tag(node);if(name==='w:del'){b.warn('DOCX_TRACKED_CHANGES','review',{part});return ''}if(name==='w:ins')b.warn('DOCX_TRACKED_CHANGES','review',{part});
  if(name==='w:footnoteReference'||name==='w:endnoteReference')b.warn('DOCX_REFERENCES_NOT_EXPANDED','review',{part});
  if(name==='w:instrText'){b.warn('DOCX_FIELDS_NOT_RENDERED','review',{part});return ''}if(name==='w:drawing'||name==='w:pict'){b.warn('IMAGE_TEXT_NOT_EXTRACTED','review',{part});return ''}
  if(name==='w:t')return kids(node).map(child=>decoded(String(child['#text']??''))).join('');if(name==='w:tab')return '\t';if(name==='w:br'||name==='w:cr')return '\n';return text(kids(node),b,part,depth+1);
 }).join('');
}
export async function parseDocx(bytes:Uint8Array,b:Builder){
 const files=await archive(bytes,b),main=files.get('word/document.xml'),types=files.get('[Content_Types].xml');
 if(!main||!types)reject('DOCX_DAMAGED');const typeXml=types.toString('utf8');if(/macroEnabled|vbaProject/i.test(typeXml))reject('DOCX_MACRO_UNSUPPORTED');if(!typeXml.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'))reject('DOCX_DAMAGED');xml(types);
 const styles=new Map<string,number>();const styleXml=files.get('word/styles.xml');if(styleXml)for(const style of find(xml(styleXml),'w:style')){const name=find(kids(style),'w:name')[0];const label=String(attr(name??{},'w:val')??attr(style,'w:styleId')??'');const match=/(?:heading|标题)\s*([1-9])/i.exec(label);if(match)styles.set(String(attr(style,'w:styleId')),Number(match[1]))}
 const rels=files.get('word/_rels/document.xml.rels');if(rels&&/TargetMode\s*=\s*["']External["']/i.test(rels.toString('utf8')))b.warn('DOCX_EXTERNAL_LINKS_NOT_FETCHED');
 b.warn('DOCX_PAGINATION_UNAVAILABLE','info');
 for(const part of ['word/document.xml',...[...files.keys()].filter(k=>/^word\/(header|footer)\d+\.xml$/.test(k)).sort()]){
  const nodes=xml(files.get(part)!);const container=find(nodes,part==='word/document.xml'?'w:body':/header/.test(part)?'w:hdr':'w:ftr')[0];if(!container)reject('DOCX_DAMAGED');let paragraph=0,table=0;
  for(const node of kids(container)){
   if(tag(node)==='w:p'){
    const source:SourceLocation={type:'docx',part,paragraph_index:paragraph++};const value=text(kids(node),b,part);const properties=kids(node).filter(n=>tag(n)==='w:pPr');const style=find(properties,'w:pStyle')[0],styleId=String(attr(style??{},'w:val')??'');const explicit=/(?:Heading|标题)\s*([1-9])/i.exec(styleId),level=styles.get(styleId)??(explicit?Number(explicit[1]):undefined);
    if(part!=='word/document.xml')b.add(/header/.test(part)?'header':'footer',value,source);
    else if(level)b.add('heading',value,source,{level});else if(find(properties,'w:numPr').length){b.warn('DOCX_LIST_NUMBERING_NOT_RENDERED','info',{part});b.add('list_item',value,source)}else b.add('paragraph',value,source);
   }else if(tag(node)==='w:tbl'){
    const tableIndex=table++,rowNodes=kids(node).filter(n=>tag(n)==='w:tr');let headerRows=0;
    const rows=rowNodes.map((row,ri)=>{if(find(kids(row).filter(n=>tag(n)==='w:trPr'),'w:tblHeader').some(enabled)&&headerRows===ri)headerRows++;if(find(kids(row).filter(n=>tag(n)==='w:trPr'),'w:gridBefore').length||find(kids(row).filter(n=>tag(n)==='w:trPr'),'w:gridAfter').length)b.warn('DOCX_TABLE_GRID_REVIEW_REQUIRED','review',{part});
     return kids(row).filter(n=>tag(n)==='w:tc').map((cell,ci)=>{const properties=kids(cell).filter(n=>tag(n)==='w:tcPr'),span=find(properties,'w:gridSpan')[0],merge=find(properties,'w:vMerge')[0];const columns=Number(attr(span??{},'w:val')??1);if(!Number.isInteger(columns)||columns<1||columns>100)reject('DOCX_DAMAGED');const source:SourceLocation={type:'docx',part,table_index:tableIndex,row_index:ri,cell_index:ci};const paras=kids(cell).filter(n=>tag(n)==='w:p');if(find(kids(cell),'w:tbl').length)b.warn('DOCX_NESTED_TABLE_REVIEW_REQUIRED','review',{part});
      const value:ParsedCell={text:paras.map(p=>text(kids(p),b,part)).join('\n'),col_span:columns,source};if(merge){value.v_merge=attr(merge,'w:val')==='restart'?'restart':'continue';b.warn('MERGED_CELLS_REVIEW_REQUIRED','review',{part})}return value;
     });
    });if(!headerRows)b.warn('TABLE_HEADER_UNSPECIFIED','review',{part});
    b.add('table',rows.map(row=>row.map(cell=>cell.text).join('\t')).join('\n'),{type:'docx',part,table_index:tableIndex},{table:{header_rows:headerRows,rows}});
   }else if(tag(node)!=='w:sectPr')b.warn('DOCX_UNSUPPORTED_BLOCK_REVIEW_REQUIRED','review',{part});
  }
 }
}
