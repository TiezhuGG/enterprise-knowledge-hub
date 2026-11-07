import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '@zhiheng/resources';
import type { AuthRequest } from '../auth/auth.guard';
import { sessionToken } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { Resources } from './resources.module';
import { id, listInput, object, searchInput } from './validation';
function noStore(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Cookie'); res.vary('Authorization'); }
function title(raw: unknown) { if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 100)
    fail(400, 'INVALID_TITLE'); return raw.trim(); }
function cursor(value: unknown) { if (value === undefined)
    return 0; if (typeof value !== 'string' || !/^\d{1,9}$/.test(value))
    fail(400, 'INVALID_EVENT_CURSOR'); return Number(value); }
@Controller()
export class ChatController {
    constructor(private readonly store: Resources, private readonly auth: AuthService) { }
    @Post('conversations')
    create(
    @Req()
    req: AuthRequest, 
    @Body()
    raw: unknown, 
    @Headers('idempotency-key')
    key = '', 
    @Res({ passthrough: true })
    res: Response) { noStore(res); const b = object(raw, ['title']); return this.store.createConversation(req.identity!, title(b.title === undefined ? '新会话' : b.title), key).then(data => ({ data })); }
    @Get('conversations')
    list(
    @Req()
    req: AuthRequest, 
    @Query()
    raw: unknown, 
    @Res({ passthrough: true })
    res: Response) { noStore(res); return this.store.conversations(req.identity!, listInput(object(raw,['q','cursor','limit']))); }
    @Get('conversations/:conversationId/messages')
    messages(
    @Req()
    req: AuthRequest, 
    @Param('conversationId')
    value: string, 
    @Query()
    raw: unknown, 
    @Res({ passthrough: true })
    res: Response) { noStore(res); return this.store.messages(req.identity!, id(value), listInput(object(raw,['cursor','limit']))); }
    @Patch('conversations/:conversationId')
    rename(
    @Req()
    req: AuthRequest, 
    @Param('conversationId')
    value: string, 
    @Body()
    raw: unknown, 
    @Headers('if-match')
    match = '', 
    @Res({ passthrough: true })
    res: Response) { noStore(res); const b = object(raw, ['title']), cid = id(value), expected = new RegExp(`^"conversation:${cid}:(\\d+)"$`).exec(match); if (!expected)
        fail(match ? 412 : 428, 'IF_MATCH_REQUIRED'); return this.store.renameConversation(req.identity!, cid, title(b.title), Number(expected[1])).then(data => ({ data })); }
    @Delete('conversations/:conversationId')
    @HttpCode(200)
    remove(
    @Req()
    req: AuthRequest, 
    @Param('conversationId')
    value: string, 
    @Res({ passthrough: true })
    res: Response) { noStore(res); return this.store.deleteConversation(req.identity!, id(value)).then(data => ({ data })); }
    @Post('chat-runs')
    @HttpCode(202)
    createRun(
    @Req()
    req: AuthRequest, 
    @Body()
    raw: unknown, 
    @Headers('idempotency-key')
    key = '', 
    @Res({ passthrough: true })
    res: Response) { noStore(res); const b = object(raw, ['conversation_id', 'message', 'kb_ids', 'top_k', 'mode', 'min_score', 'max_characters']), { conversation_id, message, ...search } = b; return this.store.createChatRun(req.identity!, id(conversation_id), searchInput({ ...search, query: message }), key).then(data => ({ data })); }
    @Get('chat-runs/:runId')
    getRun(
    @Req()
    req: AuthRequest, 
    @Param('runId')
    value: string, 
    @Res({ passthrough: true })
    res: Response) { noStore(res); return this.store.chatRun(req.identity!, id(value)).then(data => ({ data })); }
    @Post('chat-runs/:runId/cancel')
    @HttpCode(200)
    cancel(
    @Req()
    req: AuthRequest, 
    @Param('runId')
    value: string, 
    @Body()
    raw: unknown, 
    @Res({ passthrough: true })
    res: Response) { noStore(res); object(raw ?? {}, []); return this.store.cancelChatRun(req.identity!, id(value)).then(data => ({ data })); }
    @Post('chat-runs/:runId/regenerate')
    @HttpCode(202)
    regenerate(
    @Req()
    req: AuthRequest, 
    @Param('runId')
    value: string, 
    @Body()
    raw: unknown, 
    @Headers('idempotency-key')
    key = '', 
    @Res({ passthrough: true })
    res: Response) { noStore(res); object(raw ?? {}, []); return this.store.regenerateChatRun(req.identity!, id(value), key).then(data => ({ data })); }
    @Post('chat-runs/:runId/feedback')
    @HttpCode(200)
    feedback(
    @Req()
    req: AuthRequest, 
    @Param('runId')
    value: string, 
    @Body()
    raw: unknown, 
    @Res({ passthrough: true })
    res: Response) { noStore(res); const b = object(raw, ['value']); if (b.value !== 'helpful' && b.value !== 'unhelpful')
        fail(400, 'INVALID_FEEDBACK'); return this.store.feedback(req.identity!, id(value), b.value).then(data => ({ data })); }
    @Get('chat-runs/:runId/events')
    async events(
    @Req()
    req: AuthRequest, 
    @Param('runId')
    value: string, 
    @Query()
    raw: unknown, 
    @Res()
    res: Response) {
        noStore(res);
        const run = id(value), q = object(raw, ['after']), header = req.headers['last-event-id'];
        let after = cursor(header ?? q.after);
        if (header !== undefined && q.after !== undefined && after !== cursor(q.after))
            fail(400, 'INVALID_EVENT_CURSOR');
        let batch = await this.store.chatEvents(req.identity!, run, after);
        const lease = await this.store.openChatStream(req.identity!, run), abort = new AbortController(), close = () => abort.abort();
        res.on('close', close);
        try {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();
            const end = Date.now() + 120000;
            let heartbeat = Date.now();
            const control = (event: string) => res.write(`event: ${event}\ndata: ${JSON.stringify({ run_id: run, status_url: `/api/v1/chat-runs/${run}` })}\n\n`);
            while (!abort.signal.aborted && Date.now() < end) {
                const session = await this.auth.session(sessionToken(req));
                if (!session) {
                    control('stream.auth_required');
                    break;
                }
                await this.store.renewChatStream(session.identity, lease);
                // Re-read after session validation; even replayed text is authorized per batch.
                batch = await this.store.chatEvents(session.identity, run, after);
                if (batch.run.status === 'restricted') {
                    control('stream.access_revoked');
                    break;
                }
                if (batch.reset) {
                    control('stream.reset_required');
                    break;
                }
                for (const event of batch.events) {
                    if (abort.signal.aborted)
                        break;
                    if (!res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
                        res.end();
                        return;
                    }
                    after = event.seq;
                }
                if (batch.run.status !== 'running' && after >= batch.run.last_event_id)
                    break;
                if (Date.now() - heartbeat >= 15000) {
                    res.write(': heartbeat\n\n');
                    heartbeat = Date.now();
                }
                await delay(400, undefined, { signal: abort.signal }).catch(() => { });
            }
        }
        catch {
            if (!res.destroyed)
                res.write('event: stream.unavailable\ndata: {}\n\n');
        }
        finally {
            res.off('close', close);
            res.end();
            await this.store.closeChatStream(req.identity!, lease).catch(() => { });
        }
    }
}
