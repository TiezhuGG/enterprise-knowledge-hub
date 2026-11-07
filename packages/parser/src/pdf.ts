import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import type { SourceLocation,ParsedCell } from '@zhiheng/contracts';
import { Builder,ParserFailure,reject } from './common.js';
interface Item {text:string;x:number;y:number;width:number;height:number;baseline:number;rotated:boolean}
interface Line {items:Item[];text:string;x:number;y:number;width:number;height:number;font:number;cells:Item[][]}
const round=(value:number)=>Math.round(value*1000)/1000;
export async function parsePdf(bytes:Uint8Array,b:Builder){
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const require=createRequire(import.meta.url);const base=dirname(require.resolve('pdfjs-dist/package.json'));
 let document:Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>|undefined;
 try{
  document=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,cMapUrl:join(base,'cmaps/'),cMapPacked:true,standardFontDataUrl:join(base,'standard_fonts/'),verbosity:0,stopAtErrors:true}).promise;
  if(document.numPages>b.limits.maxPages)reject('PARSE_PAGE_LIMIT');b.warn('PDF_LAYOUT_REVIEW_REQUIRED');
  const pages:Array<{width:number;height:number;lines:Line[]}> = [];
  for(let number=1;number<=document.numPages;number++){
   const page=await document.getPage(number),view=page.getViewport({scale:1}),content=await page.getTextContent();const items:Item[]=[];
   for(const raw of content.items){if(!('str'in raw)||!raw.str.trim())continue;const t=pdfjs.Util.transform(view.transform,raw.transform),height=Math.hypot(t[2]!,t[3]!)||raw.height||1,w=Math.hypot(t[0]!,t[1]!)||1;const u=[t[0]!/w,t[1]!/w],v=[t[2]!/height,t[3]!/height];const points=[[t[4]!,t[5]!],[t[4]!+u[0]!*raw.width,t[5]!+u[1]!*raw.width],[t[4]!+v[0]!*height,t[5]!+v[1]!*height],[t[4]!+u[0]!*raw.width+v[0]!*height,t[5]!+u[1]!*raw.width+v[1]!*height]];const xs=points.map(p=>p[0]!),ys=points.map(p=>p[1]!);if(![...xs,...ys].every(Number.isFinite))reject('PDF_INVALID_GEOMETRY');items.push({text:raw.str,x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),baseline:t[5]!,rotated:Math.abs(t[1]!)>Math.abs(t[0]!)*.2})}
   const lines:Line[]=[];for(const item of items.sort((a,z)=>a.baseline-z.baseline||a.x-z.x)){let line=lines.at(-1);if(item.rotated||!line||Math.abs(line.items[0]!.baseline-item.baseline)>Math.max(2,item.height*.25)){line={items:[],text:'',x:item.x,y:item.y,width:0,height:0,font:item.height,cells:[]};lines.push(line)}line.items.push(item)}
   for(const line of lines){line.items.sort((a,z)=>a.x-z.x);const a=line.items[0]!;let cell:Item[]=[];for(const item of line.items){const previous=cell.at(-1);if(previous&&item.x-(previous.x+previous.width)>Math.max(18,item.height*1.5)){line.cells.push(cell);cell=[]}cell.push(item)}if(cell.length)line.cells.push(cell);line.text=line.cells.map(cell=>cell.map(i=>i.text).join(' ')).join('\t');line.x=Math.min(...line.items.map(i=>i.x));line.y=Math.min(...line.items.map(i=>i.y));line.width=Math.max(...line.items.map(i=>i.x+i.width))-line.x;line.height=Math.max(...line.items.map(i=>i.y+i.height))-line.y;line.font=Math.max(...line.items.map(i=>i.height));if(line.items.some(i=>i.rotated))b.warn('PDF_ROTATED_TEXT_REVIEW_REQUIRED','review',{page:number})}
   if(!lines.length){b.emptyPages++;b.warn('OCR_REQUIRED','review',{page:number})}pages.push({width:view.width,height:view.height,lines});page.cleanup();
  }
  const fonts=pages.flatMap(p=>p.lines.map(l=>l.font)).sort((a,z)=>a-z),normal=fonts[Math.floor(fonts.length/2)]??12;
  for(let pi=0;pi<pages.length;pi++){
   const page=pages[pi]!,location=(line:Line):SourceLocation=>({type:'pdf',page:pi+1,bbox:[round(line.x),round(line.y),round(line.width),round(line.height)],page_width:round(page.width),page_height:round(page.height)});
   for(let i=0;i<page.lines.length;i++){
    const line=page.lines[i]!;let end=i;
    if(line.cells.length>=2){while(end+1<page.lines.length){const next=page.lines[end+1]!;if(next.cells.length!==line.cells.length||next.y-page.lines[end]!.y>Math.max(40,line.height*3)||!next.cells.every((c,ci)=>Math.abs(c[0]!.x-line.cells[ci]![0]!.x)<8))break;end++}}
    if(end>i){const group=page.lines.slice(i,end+1);const rows=group.map(row=>row.cells.map(cell=>({text:cell.map(item=>item.text).join(' '),col_span:1,source:location({...row,x:cell[0]!.x,y:Math.min(...cell.map(c=>c.y)),width:cell.at(-1)!.x+cell.at(-1)!.width-cell[0]!.x,height:Math.max(...cell.map(c=>c.height))})} satisfies ParsedCell)));const box=location({...line,height:group.at(-1)!.y+group.at(-1)!.height-line.y});b.add('table',rows.map(row=>row.map(c=>c.text).join('\t')).join('\n'),box,{table:{header_rows:0,rows}});b.warn('PDF_TABLE_HEADER_REVIEW_REQUIRED','review',{page:pi+1});i=end;continue}
    if(line.cells.length>1)b.warn('PDF_COLUMNS_REVIEW_REQUIRED','review',{page:pi+1});
    const repeated=pages.filter(p=>p.lines.slice(0,2).some(l=>l.text===line.text)).length>=2&&i<2;
    const footer=pages.filter(p=>p.lines.slice(-2).some(l=>l.text===line.text)).length>=2&&i>=page.lines.length-2;
    if(repeated||footer)b.add(repeated?'header':'footer',line.text,location(line));
    else if(line.font>normal*1.3&&line.text.length<200)b.add('heading',line.text,location(line),{level:line.font>normal*1.8?1:2});
    else b.add('paragraph',line.text,location(line));
   }
  }
  return document.numPages;
 }catch(error){if(error instanceof ParserFailure)throw error;const name=(error as Error).name;if(name==='PasswordException')reject('PDF_ENCRYPTED');if(name==='InvalidPDFException'||name==='MissingPDFException')reject('PDF_DAMAGED');reject('PDF_PARSE_FAILED')}
 finally{await document?.destroy()}
}
