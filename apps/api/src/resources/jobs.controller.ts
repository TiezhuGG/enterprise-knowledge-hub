import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail, sha256 } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, listInput, object } from './validation';
@Controller('jobs')
export class JobsController {
  constructor(private readonly store:Resources){}
  @Get() list(@Req() req:AuthRequest,@Query() raw:unknown){
    const query=object(raw,['limit','cursor','status','kb_id','document_id']);const {status,kb_id,document_id,...paging}=query;
    if(status!==undefined&&(!['queued','running','retry_wait','waiting_dependency','succeeded','failed','cancelled'].includes(status as string)))fail(400,'INVALID_JOB_STATUS');
    return this.store.listJobs(req.identity!,{...listInput(paging),status:status as string|undefined,...(kb_id?{kb_id:id(kb_id)}:{}),...(document_id?{document_id:id(document_id)}:{})});
  }
  @Get(':id') get(@Req() req:AuthRequest,@Param('id') job:string){return this.store.getJob(req.identity!,id(job)).then(data=>({data}))}
  @Post(':id/retry') retry(@Req() req:AuthRequest,@Param('id') job:string,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined,@Res({passthrough:true}) res:Response){return this.operate(req,job,body,key,res,'retry')}
  @Post(':id/cancel') cancel(@Req() req:AuthRequest,@Param('id') job:string,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined,@Res({passthrough:true}) res:Response){return this.operate(req,job,body,key,res,'cancel')}
  private async operate(req:AuthRequest,job:string,raw:unknown,key:string|undefined,res:Response,action:'retry'|'cancel'){
    if(!key||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail(400,'IDEMPOTENCY_KEY_REQUIRED');
    const body=object(raw??{},['reason']);if(body.reason!==undefined&&(typeof body.reason!=='string'||body.reason.length>200))fail(400,'INVALID_REASON');
    const data=await this.store.operateJob(req.identity!,id(job),action,key,sha256(Buffer.from(JSON.stringify({reason:body.reason??''}))),String(res.getHeader('X-Request-Id')));
    res.status(action==='retry'||data.status==='running'?202:200);return {data};
  }
}
