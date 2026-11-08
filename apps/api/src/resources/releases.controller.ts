import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail, type ReleaseProbe } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, listInput, object } from './validation';
@Controller()
export class ReleasesController {
    constructor(private readonly store: Resources) { }
    private privacy(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); }
    @Get('knowledge-bases/:kbId/index-profiles')
    async profiles(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return { data: await this.store.configuredProfiles(req.identity!, id(kb)) }; }
    @Get('knowledge-bases/:kbId/index-releases')
    list(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    q: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.listReleases(req.identity!, id(kb), listInput(q)); }
    @Post('knowledge-bases/:kbId/index-releases')
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
    res: Response) { this.privacy(res); const b = object(raw, ['profile_ref']); if (typeof b.profile_ref !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(b.profile_ref))
        fail(400, 'INVALID_PROFILE_REFERENCE'); res.status(201); return { data: await this.store.createRelease(req.identity!, id(kb), b.profile_ref, key, String(res.getHeader('X-Request-Id'))) }; }
    @Get('index-releases/:releaseId')
    async get(
    @Req()
    req: AuthRequest,
    @Param('releaseId')
    value: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const data = await this.store.getRelease(req.identity!, id(value)); res.setHeader('ETag', data.etag); return { data }; }
    @Post('index-releases/:releaseId/actions')
    async action(
    @Req()
    req: AuthRequest,
    @Param('releaseId')
    value: string,
    @Body()
    raw: unknown,
    @Headers('if-match')
    etag: string | undefined,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['action', 'probes', 'note', 'quality_reviewed']), rid = id(value), requestId = String(res.getHeader('X-Request-Id')); if (!['build', 'verify', 'activate', 'rollback', 'cancel'].includes(b.action as string))
        fail(400, 'INVALID_RELEASE_ACTION'); if (b.action === 'build')
        return { data: await this.store.reconcileRelease(req.identity!, rid, etag, requestId) }; if (b.action === 'cancel')
        return { data: await this.store.cancelRelease(req.identity!, rid, etag, requestId) }; if (b.action === 'verify') {
        if (!Array.isArray(b.probes))
            fail(400, 'INVALID_RELEASE_PROBES');
        const probes = b.probes.map(raw => { const p = object(raw, ['query', 'expected_document_id']); if (typeof p.query !== 'string')
            fail(400, 'INVALID_RELEASE_PROBES'); return { query: p.query, expected_document_id: id(p.expected_document_id) }; });
        return { data: await this.store.verifyRelease(req.identity!, rid, etag, probes as ReleaseProbe[], requestId) };
    } if (typeof b.note !== 'string' || b.quality_reviewed !== true)
        fail(400, 'QUALITY_REVIEW_REQUIRED'); return { data: await (b.action === 'activate' ? this.store.activateRelease(req.identity!, rid, etag, key, b.note, true, requestId) : this.store.rollbackRelease(req.identity!, rid, etag, key, b.note, true, requestId)) }; }
    @Post('documents/:documentId/publication')
    async publish(
    @Req()
    req: AuthRequest,
    @Param('documentId')
    doc: string,
    @Body()
    raw: unknown,
    @Headers('if-match')
    etag: string | undefined,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['version_id', 'generation_id', 'note', 'quality_reviewed']); if (typeof b.note !== 'string' || b.quality_reviewed !== true)
        fail(400, 'QUALITY_REVIEW_REQUIRED'); return { data: await this.store.publishDocument(req.identity!, id(doc), id(b.version_id), id(b.generation_id), etag, key, b.note, true, String(res.getHeader('X-Request-Id'))) }; }
}
