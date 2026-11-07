import {Body,Controller,Get,HttpCode,Param,Post,Req,Res} from '@nestjs/common';import type {Response} from 'express';
import type {AuthRequest} from '../auth/auth.guard';import {Resources} from './resources.module';import {searchInput} from './validation';
@Controller()
export class SearchController {
 constructor(private readonly store:Resources){}
 @Post('answers') @HttpCode(200)
 answer(@Req() req:AuthRequest,@Body() raw:unknown,@Res({passthrough:true}) res:Response){return this.execute(req,raw,res,true)}
 @Post('search') @HttpCode(200)
 search(@Req() req:AuthRequest,@Body() raw:unknown,@Res({passthrough:true}) res:Response){return this.execute(req,raw,res,false)}
 private async execute(req:AuthRequest,raw:unknown,res:Response,answer:boolean){
  res.setHeader('Cache-Control','private, no-store');res.vary('Cookie');res.vary('Authorization');
  const input=searchInput(raw),abort=new AbortController(),cancel=()=>abort.abort();res.on('close',cancel);try{if(answer)return {data:await this.store.answer(req.identity!,input,AbortSignal.any([abort.signal,AbortSignal.timeout(95000)]))};return await this.store.search(req.identity!,input,abort.signal,typeof res.getHeader('X-Request-Id')==='string'?String(res.getHeader('X-Request-Id')):undefined)}finally{res.off('close',cancel)}
 }
 @Get('citations/:citationId') citation(@Req() req:AuthRequest,@Param('citationId') token:string,@Res({passthrough:true}) res:Response){res.setHeader('Cache-Control','private, no-store');res.vary('Cookie');res.vary('Authorization');return this.store.readCitation(req.identity!,token).then(data=>({data}))}
}
