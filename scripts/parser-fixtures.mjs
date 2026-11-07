import {createRequire} from 'node:module';
const require=createRequire(new URL('../packages/parser/package.json',import.meta.url));
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');const {zipSync,strToU8}=require('fflate');
export const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export function docx({body,extra={},styles=''}={}){
 const xml=body??'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>差旅制度</w:t></w:r></w:p><w:p><w:r><w:t>住宿 &amp; 餐补标准。</w:t></w:r></w:p><w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>城市</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>标准</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>上海</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>500</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
 const files={'[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
 'word/document.xml':`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}</w:body></w:document>`,
 'word/styles.xml':`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles||'<w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'}</w:styles>`,...extra};
 return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)]))));
}
export async function pdf({pages=2,blank=false,partial=false,javascript=false}={}){
 const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica),bold=await document.embedFont(StandardFonts.HelveticaBold);
 if(javascript)document.addJavaScript('ignored','globalThis.__pdfExecution=true;');
 for(let i=0;i<pages;i++){const page=document.addPage([600,800]);if(blank||(partial&&i>0))continue;
 page.drawText('Travel Policy',{x:50,y:740,size:22,font:bold,color:rgb(0,0,0)});page.drawText(`Page section ${i+1}`,{x:50,y:705,size:11,font});page.drawText('The original evidence must remain traceable.',{x:50,y:685,size:11,font});
 for(const [row,values] of [['Item','City','Amount'],['Hotel','Shanghai','500'],['Meal','Beijing','100']].entries())for(const [col,text] of values.entries())page.drawText(text,{x:50+col*160,y:630-row*24,size:11,font});
 page.drawText('Internal policy',{x:50,y:30,size:9,font});}
 return Buffer.from(await document.save());
}
