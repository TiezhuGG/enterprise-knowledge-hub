import { Body, Controller, Delete, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, listInput, object } from './validation';
@Controller()
export class LifecycleController {
    constructor(private readonly store: Resources) { }
    private privacy(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); }
    @Delete('documents/:documentId')
    async remove(
    @Req()
    req: AuthRequest, 
    @Param('documentId')
    doc: string, 
    @Headers('if-match')
    etag: string | undefined, 
    @Headers('idempotency-key')
    key = '', 
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const data = await this.store.deleteDocument(req.identity!, id(doc), etag, key, String(res.getHeader('X-Request-Id'))); res.status(202); return { data }; }
    @Get('knowledge-bases/:kbId/cleanups')
    list(
    @Req()
    req: AuthRequest, 
    @Param('kbId')
    kb: string, 
    @Query()
    query: unknown, 
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.listCleanups(req.identity!, id(kb), listInput(query)); }
    @Get('cleanups/:cleanupId')
    async get(
    @Req()
    req: AuthRequest, 
    @Param('cleanupId')
    value: string, 
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return { data: await this.store.getCleanup(req.identity!, id(value)) }; }
    @Post('cleanups/:cleanupId/actions')
    async action(
    @Req()
    req: AuthRequest, 
    @Param('cleanupId')
    value: string, 
    @Body()
    raw: unknown, 
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['action', 'note']); if (!['retry', 'reconcile_writes', 'bind_legacy'].includes(b.action as string) || typeof b.note !== 'string' || b.note.trim().length < 10 || b.note.length > 2000)
        fail(400, 'INVALID_CLEANUP_ACTION'); return { data: await this.store.cleanupAction(req.identity!, id(value), b.action as 'retry' | 'reconcile_writes' | 'bind_legacy', b.note.trim(), String(res.getHeader('X-Request-Id'))) }; }
}
