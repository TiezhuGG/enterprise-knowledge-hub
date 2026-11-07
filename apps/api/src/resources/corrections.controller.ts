import {Body,Controller,Get,Headers,Param,Patch,Post,Query,Req,Res} from '@nestjs/common';
import type {Response} from 'express';import type {CorrectionKind,CorrectionAction,CorrectionDetails} from '@zhiheng/contracts';
import {correctionEtag,fail} from '@zhiheng/resources';import type {AuthRequest} from '../auth/auth.guard';import {Resources} from './resources.module';import {id,object,listInput} from './validation';
function text(v:unknown,max:number){if(typeof v!=='string'||Array.from(v.trim()).length<10||v.trim().length>max)fail(400,'INVALID_CORRECTION_TEXT');return v.trim()}
function privateResponse(res:Response){res.setHeader('Cache-Control','private, no-store');res.vary('Cookie');res.vary('Authorization')}
function result(data:CorrectionDetails,res:Response){res.setHeader('ETag',correctionEtag(data));return {data}}
@Controller()
export class CorrectionsController {
 constructor(private readonly store:Resources){}
 @Post('documents/:documentId/versions/:versionId/corrections')
 async create(@Req() req:AuthRequest,@Param('documentId') doc:string,@Param('versionId') version:string,@Body() raw:unknown,@Headers('idempotency-key') key='',@Res({passthrough:true}) res:Response){privateResponse(res);const b=object(raw,['kind','description','block_id']);if(!['source_content','extraction','processing'].includes(b.kind as string))fail(400,'INVALID_CORRECTION_KIND');return result(await this.store.createCorrection(req.identity!,id(doc),id(version),{kind:b.kind as CorrectionKind,description:text(b.description,2000),...(b.block_id===undefined?{}:{block_id:id(b.block_id)})},key,String(res.getHeader('X-Request-Id'))),res)}
 @Get('documents/:documentId/versions/:versionId/corrections')
 list(@Req() req:AuthRequest,@Param('documentId') doc:string,@Param('versionId') version:string,@Query() raw:unknown,@Res({passthrough:true}) res:Response){privateResponse(res);const q=object(raw,['limit','cursor','status']);if(q.status!==undefined&&!['open','in_progress','awaiting_validation','resolved','dismissed'].includes(q.status as string))fail(400,'INVALID_CORRECTION_STATUS');const {status,...paging}=q;return this.store.listCorrections(req.identity!,id(doc),id(version),{...listInput(paging),status:status as string|undefined})}
 @Get('corrections/:caseId')
 async get(@Req() req:AuthRequest,@Param('caseId') value:string,@Res({passthrough:true}) res:Response){privateResponse(res);return result(await this.store.getCorrection(req.identity!,id(value)),res)}
 @Patch('corrections/:caseId')
 async change(@Req() req:AuthRequest,@Param('caseId') value:string,@Body() raw:unknown,@Headers('if-match') etag:string|undefined,@Headers('idempotency-key') key='',@Res({passthrough:true}) res:Response){privateResponse(res);const b=object(raw,['action','note','replacement_version_id']);if(!['claim','verify','retry','submit_fix','resolve','dismiss','reopen'].includes(b.action as string))fail(400,'INVALID_CORRECTION_ACTION');if(b.replacement_version_id!==undefined&&b.action!=='submit_fix')fail(400,'UNEXPECTED_REPLACEMENT');return result(await this.store.changeCorrection(req.identity!,id(value),{action:b.action as CorrectionAction,note:text(b.note,2000),...(b.replacement_version_id===undefined?{}:{replacement_version_id:id(b.replacement_version_id)})},etag,key,String(res.getHeader('X-Request-Id'))),res)}
}
