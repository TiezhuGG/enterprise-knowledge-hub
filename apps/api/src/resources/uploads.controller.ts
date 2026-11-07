import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail, type UploadInput } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, object, listInput } from './validation';
const requestId=(res:Response)=>String(res.getHeader('X-Request-Id'));
function key(value:string|undefined){if(!value||!/^[A-Za-z0-9_-]{8,128}$/.test(value))fail(400,'IDEMPOTENCY_KEY_REQUIRED');return value}
let receiving=0;
@Controller('upload-tickets')
export class UploadController {
  constructor(private readonly store:Resources){}
  @Post() create(@Req() req:AuthRequest,@Body() raw:unknown,@Headers('idempotency-key') token:string|undefined,@Res({passthrough:true}) res:Response){
    const body=object(raw,['kb_id','document_id','filename','size','mime','sha256']);
    const input:UploadInput={kb_id:id(body.kb_id),...(body.document_id!==undefined?{document_id:id(body.document_id)}:{}),filename:body.filename as string,size:body.size as number,mime:body.mime as string,sha256:body.sha256 as string};
    return this.store.createUpload(req.identity!,input,key(token),requestId(res)).then(data=>({data}));
  }
  @Get(':id') get(@Req() req:AuthRequest,@Param('id') ticketId:string){return this.store.getUpload(req.identity!,id(ticketId)).then(data=>({data}))}
  @Put(':id/content') @HttpCode(204)
  async receive(@Req() req:AuthRequest,@Param('id') ticketId:string,@Res({passthrough:true}) res:Response){
    if(receiving>=4)fail(429,'UPLOAD_CONCURRENCY_LIMIT');
    if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail(415,'UNSUPPORTED_CONTENT_ENCODING');
    const rawLength=req.headers['content-length'];
    if(rawLength!==undefined&&!/^\d+$/.test(rawLength))fail(400,'INVALID_CONTENT_LENGTH');
    const length=rawLength===undefined?undefined:Number(rawLength);receiving++;
    try{
      await this.store.receiveUpload(req.identity!,id(ticketId),req.headers['content-type']??'',length,async expected=>{
        const chunks:Buffer[]=[];let size=0;req.setTimeout(30000,()=>req.destroy());
        try{for await(const raw of req.iterator({destroyOnReturn:false})){const chunk=Buffer.from(raw);size+=chunk.length;if(size>expected)fail(413,'UPLOAD_TOO_LARGE');chunks.push(chunk)}}
        catch(error){if(error instanceof Error&&'status' in error)throw error;return fail(400,'UPLOAD_INTERRUPTED')}
        finally{req.setTimeout(0)}
        return Buffer.concat(chunks);
      },requestId(res));
    }catch(error){res.setHeader('Connection','close');throw error}
    finally{receiving--}
  }
  @Post(':id/finalize') @HttpCode(202)
  finalize(@Req() req:AuthRequest,@Param('id') ticketId:string,@Body() raw:unknown,@Headers('idempotency-key') token:string|undefined,@Res({passthrough:true}) res:Response){
    key(token);const body=object(raw,['sha256']);if(typeof body.sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.sha256))fail(400,'INVALID_SHA256');
    return this.store.finalizeUpload(req.identity!,id(ticketId),body.sha256,requestId(res)).then(data=>({data}));
  }
}
@Controller('documents/:documentId/versions')
export class VersionsController {
  constructor(private readonly store:Resources){}
  @Get() list(@Req() req:AuthRequest,@Param('documentId') doc:string,@Query() query:unknown){object(query,['limit','cursor']);return this.store.listVersions(req.identity!,id(doc),listInput(query))}
  @Get(':versionId') get(@Req() req:AuthRequest,@Param('documentId') doc:string,@Param('versionId') version:string){return this.store.getVersion(req.identity!,id(doc),id(version)).then(data=>({data}))}
  @Get(':versionId/parsed')
  parsed(@Req() req:AuthRequest,@Param('documentId') doc:string,@Param('versionId') version:string,@Query() raw:unknown){
    const query=object(raw,['limit','cursor','page']);const {page,...paging}=query;const input=listInput(paging);let number:number|undefined;
    if(page!==undefined){number=Number(page);if(typeof page!=='string'||!Number.isInteger(number)||number<1||number>1000)fail(400,'INVALID_PAGE')}
    return this.store.getParsed(req.identity!,id(doc),id(version),{limit:input.limit,cursor:input.cursor,page:number}).then(data=>({data}));
  }
  @Get(':versionId/content')
  async content(@Req() req:AuthRequest,@Param('documentId') docValue:string,@Param('versionId') versionValue:string,@Res() res:Response){
    const doc=id(docValue),version=id(versionValue);const {bytes,metadata}=await this.store.sourceForDownload(req.identity!,doc,version);
    let start=0,end=bytes.length-1;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);res.setHeader('Content-Range',`bytes */${bytes.length}`);
      if(!match||(!match[1]&&!match[2]))fail(416,'INVALID_RANGE');
      if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<1)fail(416,'INVALID_RANGE');start=Math.max(0,bytes.length-suffix)}
      else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]))}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length)fail(416,'INVALID_RANGE');
      res.status(206);res.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`);
    }
    res.setHeader('Content-Type','application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);
    const filename=encodeURIComponent(metadata.filename).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition',`attachment; filename="source-file"; filename*=UTF-8''${filename}`);
    try{
      for(let offset=start;offset<=end;offset+=65536){
        if(res.destroyed)return;await this.store.checkDownload(req.identity!,doc,version);
        if(!res.write(bytes.subarray(offset,Math.min(offset+65536,end+1))))await new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve()};res.once('drain',done);res.once('close',done)});
      }
      res.end();
    }catch(error){if(res.headersSent){res.destroy();return}res.removeHeader('Content-Disposition');res.removeHeader('Content-Length');res.removeHeader('Content-Range');throw error}
  }
}
