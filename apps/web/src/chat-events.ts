import type { ChatEvent, ChatRun, ChatStage, SearchEvidence } from '@zhiheng/contracts';
export interface LiveChat {
    id: string;
    seq: number;
    stage: ChatStage;
    sources: Record<string, SearchEvidence>;
    quotes: Record<number, {
        evidence_id: string;
        quote: string;
    }>;
    terminal: boolean;
}
export function liveChat(run: ChatRun): LiveChat { return { id: run.id, seq: run.last_event_id, stage: run.stage, sources: {}, quotes: {}, terminal: run.status !== 'running' }; }
export function applyChatEvent(state: LiveChat, event: ChatEvent): LiveChat {
    if (event.run_id !== state.id || !Number.isSafeInteger(event.seq) || event.seq < 1)
        throw new Error('INVALID_EVENT');
    if (event.seq <= state.seq)
        return state;
    if (event.seq !== state.seq + 1 || state.terminal)
        throw new Error('EVENT_GAP');
    const next = { ...state, seq: event.seq };
    if (event.type === 'run.progress' || event.type === 'run.started') {
        if (event.stage)
            next.stage = event.stage;
    }
    else if (event.type === 'citation.upsert' && event.source?.evidence_id)
        next.sources = { ...state.sources, [event.source.evidence_id]: event.source };
    else if (event.type === 'answer.delta') {
        if (event.claim_index === undefined || !event.evidence_id || !state.sources[event.evidence_id] || typeof event.delta !== 'string')
            throw new Error('INVALID_EVENT');
        next.quotes = { ...state.quotes, [event.claim_index]: { evidence_id: event.evidence_id, quote: (state.quotes[event.claim_index]?.quote ?? '') + event.delta } };
    }
    else if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
        next.terminal = true;
        next.stage = 'finished';
    }
    return next;
}
export const stageLabel: Record<ChatStage, string> = { queued: '请求已登记', retrieving: '正在检索授权资料', generating: '正在选择原文摘录', validating: '正在核验引用与权限', finished: '运行已结束' };
