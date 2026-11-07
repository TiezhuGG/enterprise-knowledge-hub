import { Body, Controller, Get, Headers, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth.guard';
import { kbEtag, docEtag, fail, type KnowledgeInput } from '@zhiheng/resources';
import { Resources } from './resources.module';
import { grantInput, id, knowledgeInput, listInput } from './validation';
const requestId=(res:Response)=>String(res.getHeader('X-Request-Id'));
@Controller('knowledge-bases')
export class KnowledgeController {
  constructor(private readonly store:Resources) {}
  @Get() list(@Req() req:AuthRequest,@Query() query:unknown) { return this.store.listKnowledgeBases(req.identity!,listInput(query)); }
  @Post() async create(@Req() req:AuthRequest,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined,@Res({passthrough:true}) res:Response) {
    if(!key||!(/^[A-Za-z0-9_-]{8,128}$/).test(key)) fail(400,'IDEMPOTENCY_KEY_REQUIRED');
    const data=await this.store.createKnowledgeBase(req.identity!,knowledgeInput(body) as KnowledgeInput,key,requestId(res));
    res.setHeader('ETag',kbEtag(data)); return {data};
  }
  @Get(':id') async get(@Req() req:AuthRequest,@Param('id') resourceId:string,@Res({passthrough:true}) res:Response) {
    const data=await this.store.getKnowledgeBase(req.identity!,id(resourceId));res.setHeader('ETag',kbEtag(data));return {data};
  }
  @Patch(':id') async update(@Req() req:AuthRequest,@Param('id') resourceId:string,@Body() body:unknown,@Headers('if-match') etag:string|undefined,@Res({passthrough:true}) res:Response) {
    const data=await this.store.updateKnowledgeBase(req.identity!,id(resourceId),knowledgeInput(body,true),etag,requestId(res)); res.setHeader('ETag',kbEtag(data)); return {data};
  }
  @Get(':id/acl') async acl(@Req() req:AuthRequest,@Param('id') resourceId:string,@Res({passthrough:true}) res:Response) {
    const {etag,...data}=await this.store.getKnowledgeAcl(req.identity!,id(resourceId));res.setHeader('ETag',etag);return {data};
  }
  @Put(':id/acl') async setAcl(@Req() req:AuthRequest,@Param('id') resourceId:string,@Body() body:unknown,@Headers('if-match') match:string|undefined,@Res({passthrough:true}) res:Response) {
    const {etag,...data}=await this.store.setKnowledgeAcl(req.identity!,id(resourceId),grantInput(body).grants,match,requestId(res));res.setHeader('ETag',etag);return {data};
  }
  @Get(':id/documents') documents(@Req() req:AuthRequest,@Param('id') resourceId:string,@Query() query:unknown) { return this.store.listDocuments(req.identity!,id(resourceId),listInput(query,true)); }
}
@Controller('documents')
export class DocumentController {
  constructor(private readonly store:Resources) {}
  @Get(':id') async get(@Req() req:AuthRequest,@Param('id') resourceId:string,@Res({passthrough:true}) res:Response) {
    const data=await this.store.getDocument(req.identity!,id(resourceId));res.setHeader('ETag',docEtag(data));return {data};
  }
  @Get(':id/acl') async acl(@Req() req:AuthRequest,@Param('id') resourceId:string,@Res({passthrough:true}) res:Response) {
    const {etag,...data}=await this.store.getDocumentAcl(req.identity!,id(resourceId));res.setHeader('ETag',etag);return {data};
  }
  @Put(':id/acl') async setAcl(@Req() req:AuthRequest,@Param('id') resourceId:string,@Body() body:unknown,@Headers('if-match') match:string|undefined,@Res({passthrough:true}) res:Response) {
    const input=grantInput(body,true);const {etag,...data}=await this.store.setDocumentAcl(req.identity!,id(resourceId),input.acl_mode!,input.grants,match,requestId(res));res.setHeader('ETag',etag);return {data};
  }
}
