import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import type { ParsedCell, SourceLocation } from '@zhiheng/contracts';
import { Builder, decodeText, reject } from './common.js';
export function parseText(bytes:Uint8Array,b:Builder){
 const text=decodeText(bytes);if(text.length>b.limits.maxCharacters)reject('PARSE_TEXT_LIMIT');
 const lines:Array<{start:number;end:number;text:string}>=[];let start=0;
 for(const match of text.matchAll(/\r\n|\n|\r/g)){lines.push({start,end:match.index,text:text.slice(start,match.index)});start=match.index+match[0].length}lines.push({start,end:text.length,text:text.slice(start)});
 let first=-1;
 const emit=(end:number)=>{if(first<0)return;const a=lines[first]!,z=lines[end]!;let left=a.start,right=z.end;while(left<right&&/\s|\uFEFF/.test(text[left]!))left++;while(right>left&&/\s/.test(text[right-1]!))right--;b.add('paragraph',text.slice(left,right),{type:'text',char_start:left,char_end:right,line_start:first+1,line_end:end+1});first=-1};
 for(let i=0;i<lines.length;i++){if(!lines[i]!.text.trim())emit(i-1);else if(first<0)first=i}emit(lines.length-1);
}
type Node={type:string;value?:string;depth?:number;children?:Node[];position?:{start:{offset?:number;line:number};end:{offset?:number;line:number}}};
function value(n:Node):string {if(typeof n.value==='string')return n.value;if(n.type==='break')return '\n';if(n.type==='image')return '';return (n.children??[]).map(value).join('')}
function source(n:Node):SourceLocation{return {type:'text',char_start:n.position?.start.offset??0,char_end:n.position?.end.offset??0,line_start:n.position?.start.line??1,line_end:n.position?.end.line??1}}
export function parseMarkdown(bytes:Uint8Array,b:Builder){
 const text=decodeText(bytes);if(text.length>b.limits.maxCharacters)reject('PARSE_TEXT_LIMIT');
 const root=fromMarkdown(text,{extensions:[gfmTable()],mdastExtensions:[gfmTableFromMarkdown()]}) as Node;
 function visit(n:Node,depth=0){
  if(depth>100)reject('PARSE_RESOURCE_LIMIT');
  switch(n.type){
   case 'heading':b.add('heading',value(n),source(n),{level:n.depth??1});break;
   case 'paragraph':b.add('paragraph',value(n),source(n));break;
   case 'code':b.add('code',n.value??'',source(n));break;
   case 'listItem':b.add('list_item',(n.children??[]).filter(c=>c.type!=='list').map(value).join('\n'),source(n));for(const child of n.children??[])if(child.type==='list')visit(child,depth+1);break;
   case 'table':{const rows=(n.children??[]).map(row=>(row.children??[]).map(cell=>({text:value(cell),col_span:1,source:source(cell)} satisfies ParsedCell)));b.add('table',rows.map(row=>row.map(c=>c.text).join('\t')).join('\n'),source(n),{table:{header_rows:1,rows}});break}
   case 'html':b.warn('MARKDOWN_HTML_PRESERVED_AS_TEXT');b.add('code',n.value??'',source(n));break;
   case 'image':b.warn('IMAGE_TEXT_NOT_EXTRACTED');break;
   default:for(const child of n.children??[])visit(child,depth+1);
  }
 }
 visit(root);if(/!\[/.test(text))b.warn('IMAGE_TEXT_NOT_EXTRACTED');
}
