import {Body,Controller,Get,HttpCode,Param,Post,Req,Res} from '@nestjs/common';import type {Response} from 'express';
import type {SearchInput} from '@zhiheng/contracts';import {fail} from '@zhiheng/resources';import type {AuthRequest} from '../auth/auth.guard';import {Resources} from './resources.module';import {object,id} from './validation';
@Controller()
export class SearchController {
 constructor(private readonly store:Resources){}
 @Post('answers') @HttpCode(200)
 answer(@Req() req:AuthRequest,@Body() raw:unknown,@Res({passthrough:true}) res:Response){return this.execute(req,raw,res,true)}
 @Post('search') @HttpCode(200)
 search(@Req() req:AuthRequest,@Body() raw:unknown,@Res({passthrough:true}) res:Response){return this.execute(req,raw,res,false)}
 private async execute(req:AuthRequest,raw:unknown,res:Response,answer:boolean){
  res.setHeader('Cache-Control','private, no-store');res.vary('Cookie');res.vary('Authorization');
  const b=object(raw,['query','kb_ids','top_k','mode','min_score','max_characters']);if(typeof b.query!=='string'||!b.query.trim()||b.query.trim().length>1200)fail(400,'INVALID_QUERY');if(b.mode!==undefined&&b.mode!=='dense')fail(400,'UNSUPPORTED_SEARCH_MODE');
  const integer=(v:unknown,d:number,min:number,max:number)=>{const n=v===undefined?d:v;if(typeof n!=='number'||!Number.isInteger(n)||n<min||n>max)fail(400,'INVALID_SEARCH_LIMIT');return n};let kbs:string[]|undefined;
  if(b.kb_ids!==undefined){if(!Array.isArray(b.kb_ids)||!b.kb_ids.length||b.kb_ids.length>10)fail(400,'INVALID_KB_SCOPE');kbs=[...new Set(b.kb_ids.map(id))]}
  const min=b.min_score===undefined?0.25:b.min_score;if(typeof min!=='number'||!Number.isFinite(min)||min< -1||min>1)fail(400,'INVALID_MIN_SCORE');
  const input:SearchInput={query:b.query.trim(),kb_ids:kbs,top_k:integer(b.top_k,5,1,20),mode:'dense',min_score:min,max_characters:integer(b.max_characters,6000,500,16000)},abort=new AbortController(),cancel=()=>abort.abort();res.on('close',cancel);try{if(answer)return {data:await this.store.answer(req.identity!,input,AbortSignal.any([abort.signal,AbortSignal.timeout(95000)]))};return await this.store.search(req.identity!,input,abort.signal,typeof res.getHeader('X-Request-Id')==='string'?String(res.getHeader('X-Request-Id')):undefined)}finally{res.off('close',cancel)}
 }
 @Get('citations/:citationId') citation(@Req() req:AuthRequest,@Param('citationId') token:string,@Res({passthrough:true}) res:Response){res.setHeader('Cache-Control','private, no-store');res.vary('Cookie');res.vary('Authorization');return this.store.readCitation(req.identity!,token).then(data=>({data}))}
}
