import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fail } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, listInput, object } from './validation';
@Controller()
export class LabController {
    constructor(private readonly store: Resources) { }
    private privacy(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); }
    @Get('knowledge-bases/:kbId/retrieval-strategy')
    async active(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const data = await this.store.activeStrategy(req.identity!, id(kb)); res.setHeader('ETag', data.etag); return { data }; }
    @Get('knowledge-bases/:kbId/retrieval-strategies')
    list(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    q: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.listStrategies(req.identity!, id(kb), listInput(q)); }
    @Post('knowledge-bases/:kbId/retrieval-strategies')
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
    res: Response) { this.privacy(res); const b = object(raw, ['name', 'config']); if (typeof b.name !== 'string')
        fail(400, 'INVALID_STRATEGY_NAME'); return { data: await this.store.createStrategy(req.identity!, id(kb), b.name, b.config, key, String(res.getHeader('X-Request-Id'))) }; }
    @Get('knowledge-bases/:kbId/retrieval-experiments')
    experiments(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    q: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.listExperiments(req.identity!, id(kb), listInput(q)); }
    @Post('retrieval-strategies/:strategyId/experiments')
    async compare(
    @Req()
    req: AuthRequest,
    @Param('strategyId')
    version: string,
    @Body()
    raw: unknown,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['probes']); if (!Array.isArray(b.probes))
        fail(400, 'INVALID_LAB_PROBES'); const probes = b.probes.map(raw => { const p = object(raw, ['query', 'expected_document_ids']); if (typeof p.query !== 'string' || !Array.isArray(p.expected_document_ids))
        fail(400, 'INVALID_LAB_PROBES'); return { query: p.query, expected_document_ids: p.expected_document_ids.map(id) }; }), abort = new AbortController(), cancel = () => abort.abort(); res.on('close', cancel); try {
        return { data: await this.store.runExperiment(req.identity!, id(version), probes, key, String(res.getHeader('X-Request-Id')), AbortSignal.any([abort.signal, AbortSignal.timeout(120000)])) };
    }
    finally {
        res.off('close', cancel);
    } }
    @Get('retrieval-experiments/:experimentId')
    async get(
    @Req()
    req: AuthRequest,
    @Param('experimentId')
    value: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return { data: await this.store.getExperiment(req.identity!, id(value)) }; }
    @Get('retrieval-experiments/:experimentId/source')
    async source(
    @Req()
    req: AuthRequest,
    @Param('experimentId')
    value: string,
    @Query()
    raw: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const q = object(raw, ['row', 'side', 'ordinal']); if (!['baseline', 'candidate'].includes(q.side as string) || typeof q.row !== 'string' || !/^\d{1,2}$/.test(q.row) || typeof q.ordinal !== 'string' || !/^\d{1,2}$/.test(q.ordinal))
        fail(400, 'INVALID_LAB_SOURCE'); return { data: await this.store.experimentSource(req.identity!, id(value), Number(q.row), q.side as 'baseline' | 'candidate', Number(q.ordinal)) }; }
    @Post('retrieval-strategies/:strategyId/publication')
    async publish(
    @Req()
    req: AuthRequest,
    @Param('strategyId')
    version: string,
    @Body()
    raw: unknown,
    @Headers('idempotency-key')
    key = '',
    @Headers('if-match')
    etag: string | undefined,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['experiment_id', 'note', 'reviewed']); if (typeof b.note !== 'string' || b.reviewed !== true)
        fail(400, 'STRATEGY_REVIEW_REQUIRED'); return { data: await this.store.publishStrategy(req.identity!, id(version), id(b.experiment_id), etag, key, b.note, true, String(res.getHeader('X-Request-Id'))) }; }
    @Get('knowledge-bases/:kbId/retrieval-strategy-history')
    history(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    q: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return this.store.strategyHistory(req.identity!, id(kb), listInput(q)); }
}
