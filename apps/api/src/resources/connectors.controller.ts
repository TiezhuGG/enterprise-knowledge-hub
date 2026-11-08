import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, listInput, object } from './validation';
@Controller()
export class ConnectorsController {
    constructor(private readonly store: Resources) { }
    private privacy(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); }
    @Post('knowledge-bases/:kbId/connectors')
    async create(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Body()
    raw: unknown,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['config_ref']); if (typeof b.config_ref !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.config_ref))
        fail(400, 'INVALID_SOURCE_REFERENCE'); const data = await this.store.createConnector(req.identity!, id(kb), b.config_ref, key, String(res.getHeader('X-Request-Id'))); res.status(201); return { data }; }
    @Get('knowledge-bases/:kbId/connectors')
    list(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    q: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.listConnectors(req.identity!, id(kb), listInput(q)); }
    @Get('connectors/:connectorId')
    async get(
    @Req()
    req: AuthRequest,
    @Param('connectorId')
    value: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const data = await this.store.getConnector(req.identity!, id(value)); res.setHeader('ETag', `"connector:${data.id}:${data.row_version}"`); return { data }; }
    @Get('connectors/:connectorId/documents')
    listDocuments(
    @Req()
    req: AuthRequest,
    @Param('connectorId')
    value: string,
    @Query()
    q: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.listConnectorDocuments(req.identity!, id(value), listInput(q)); }
    @Post('connectors/:connectorId/sync')
    async sync(
    @Req()
    req: AuthRequest,
    @Param('connectorId')
    value: string,
    @Body()
    raw: unknown,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['mode']); if (b.mode !== undefined && !['incremental', 'full'].includes(b.mode as string))
        fail(400, 'INVALID_SYNC_MODE'); res.status(202); return { data: await this.store.startSync(req.identity!, id(value), (b.mode ?? 'incremental') as 'incremental' | 'full', key, String(res.getHeader('X-Request-Id'))) }; }
    @Post('connectors/:connectorId/actions')
    async action(
    @Req()
    req: AuthRequest,
    @Param('connectorId')
    value: string,
    @Body()
    raw: unknown,
    @Headers('if-match')
    etag: string | undefined,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['action']); if (!['pause', 'resume', 'remove'].includes(b.action as string))
        fail(400, 'INVALID_CONNECTOR_ACTION'); return { data: await this.store.connectorAction(req.identity!, id(value), b.action as 'pause' | 'resume' | 'remove', etag, String(res.getHeader('X-Request-Id'))) }; }
}
