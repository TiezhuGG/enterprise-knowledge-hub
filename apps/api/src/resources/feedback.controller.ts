import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GAP_KINDS, GAP_STATES, fail, type FeedbackInput, type FeedbackChange, type FeedbackList } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { Resources } from './resources.module';
import { id, listInput, object } from './validation';
const fields = ['action', 'note', 'reviewed', 'kind', 'priority', 'assignee_id', 'duplicate_of', 'document_id', 'version_id', 'correction_id', 'expected_document_ids'];
const actions = ['triage', 'assign', 'claim', 'note', 'link_fix', 'approve_regression', 'resolve', 'dismiss', 'duplicate', 'reopen'];
@Controller()
export class FeedbackController {
    constructor(private readonly store: Resources) { }
    private privacy(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); }
    @Post('knowledge-bases/:kbId/feedback')
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
    res: Response) { this.privacy(res); const b = object(raw, ['question', 'description', 'kind', 'priority', 'shared', 'run_id', 'document_id', 'version_id']); if (typeof b.question !== 'string' || typeof b.description !== 'string' || !GAP_KINDS.includes(b.kind as never) || !['normal', 'high'].includes(b.priority as string) || b.shared !== true)
        fail(400, 'INVALID_FEEDBACK_FIELDS'); for (const name of ['run_id', 'document_id', 'version_id'])
        if (b[name] !== undefined)
            b[name] = id(b[name]); const data = await this.store.createFeedback(req.identity!, id(kb), b as unknown as FeedbackInput, key, String(res.getHeader('X-Request-Id'))); res.setHeader('ETag', data.etag); return { data }; }
    @Get('knowledge-bases/:kbId/feedback')
    list(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    raw: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const q = object(raw, ['limit', 'cursor', 'status', 'kind', 'priority']), { status, kind, priority, ...paging } = q; if (status !== undefined && !GAP_STATES.includes(status as never) || kind !== undefined && !GAP_KINDS.includes(kind as never) || priority !== undefined && !['normal', 'high'].includes(priority as string))
        fail(400, 'INVALID_FEEDBACK_FILTER'); return this.store.listFeedback(req.identity!, id(kb), { ...listInput(paging), status, kind, priority } as FeedbackList); }
    @Get('knowledge-bases/:kbId/feedback-stats')
    async stats(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); return { data: await this.store.feedbackStats(req.identity!, id(kb)) }; }
    @Get('knowledge-bases/:kbId/feedback-owners')
    async owners(
    @Req()
    req: AuthRequest,
    @Param('kbId')
    kb: string,
    @Query()
    raw: unknown,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const q = object(raw, ['case_id']); return { data: await this.store.feedbackOwners(req.identity!, id(kb), q.case_id === undefined ? undefined : id(q.case_id)) }; }
    @Get('feedback/:caseId')
    async get(
    @Req()
    req: AuthRequest,
    @Param('caseId')
    value: string,
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const data = await this.store.getFeedback(req.identity!, id(value)); res.setHeader('ETag', data.etag); return { data }; }
    @Post('feedback/:caseId/actions')
    async change(
    @Req()
    req: AuthRequest,
    @Param('caseId')
    value: string,
    @Body()
    raw: unknown,
    @Headers('if-match')
    etag: string | undefined,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, fields); if (!actions.includes(b.action as string) || typeof b.note !== 'string' || b.reviewed !== undefined && typeof b.reviewed !== 'boolean')
        fail(400, 'INVALID_FEEDBACK_ACTION'); if (b.kind !== undefined && !GAP_KINDS.includes(b.kind as never) || b.priority !== undefined && !['normal', 'high'].includes(b.priority as string))
        fail(400, 'INVALID_FEEDBACK_FIELDS'); for (const name of ['assignee_id', 'duplicate_of', 'document_id', 'version_id', 'correction_id'])
        if (b[name] !== undefined)
            b[name] = id(b[name]); if (b.expected_document_ids !== undefined) {
        if (!Array.isArray(b.expected_document_ids))
            fail(400, 'INVALID_FEEDBACK_FIELDS');
        b.expected_document_ids = b.expected_document_ids.map(id);
    } const data = await this.store.changeFeedback(req.identity!, id(value), b as unknown as FeedbackChange, etag, key, String(res.getHeader('X-Request-Id'))); res.setHeader('ETag', data.etag); return { data }; }
    @Post('feedback/:caseId/regression-runs')
    async regression(
    @Req()
    req: AuthRequest,
    @Param('caseId')
    value: string,
    @Body()
    raw: unknown,
    @Headers('if-match')
    etag: string | undefined,
    @Headers('idempotency-key')
    key = '',
    @Res({ passthrough: true })
    res: Response) { this.privacy(res); const b = object(raw, ['strategy_id']), abort = new AbortController(), cancel = () => abort.abort(); res.on('close', cancel); try {
        return { data: await this.store.runFeedbackRegression(req.identity!, id(value), id(b.strategy_id), etag, key, String(res.getHeader('X-Request-Id')), AbortSignal.any([abort.signal, AbortSignal.timeout(120000)])) };
    }
    finally {
        res.off('close', cancel);
    } }
}
