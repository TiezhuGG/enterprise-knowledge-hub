import {indexProfileHash} from './index-profiles';
import { rerank, rerankProfile, rerankOptions, contextOptions, rerankInputs, RerankFailure } from './reranking';
import { hybridOptions, reciprocalRankFusion, canDegrade } from './fusion';
import { bm25, lexicalQuery, LEXICAL_VERSION, DICTIONARY_HASH } from './lexical';
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext, SearchInput, SearchResponse, SearchEvidence, KnowledgeChunk, FusionEvidence, RerankMeta } from '@zhiheng/contracts';
import {StrategyStore} from './strategies';
import { kbCaps, docCaps } from './store';
import { ROLE_ACTIONS, ResourceError, fail } from './policy';
import { embeddingProfile, embedQuery, IndexFailure } from './embedding';
import { DenseIndex } from './dense-index';
const MAX_SCOPE = 200;
type Target = {
    document_id: string;
    version_id: string;
    generation_id: string;
    profile_hash: string;
    title: string;
};
type Candidate = {
    target: Target;
    chunk: KnowledgeChunk;
    score: number;
    retrieval?: FusionEvidence;
    rerank?: {
        rank: number;
        score: number;
        original_rank: number;
        truncated: boolean;
    };
};
const candidateKey = (c: Candidate) => [c.target.document_id, c.target.version_id, c.target.generation_id, c.chunk.id].join(':');
export class RetrievalStore extends StrategyStore {
    private readonly reranking = new Set<string>();
    protected async eligible(client: PoolClient, member: IdentityContext, kbs?: string[]): Promise<Target[]> {
        if (kbs)
            for (const kb of [...kbs].sort())
                await this.kb(client, member, kb, 'read');
        const found = await client.query(`SELECT id AS document_id,published_version_id AS version_id,published_generation_id AS generation_id,profile_hash,title FROM (
   SELECT d.*,g.profile_hash,CASE WHEN d.acl_mode='inherit' THEN ${kbCaps} ELSE ARRAY(SELECT unnest(${kbCaps}) INTERSECT SELECT unnest(${docCaps})) END AS caps
   FROM document d JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id
   JOIN document_version v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.id=d.published_version_id
   JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id
   JOIN index_generation g ON g.tenant_id=d.tenant_id AND g.document_id=d.id AND g.version_id=v.id AND g.id=d.published_generation_id
   WHERE d.tenant_id=$1 AND source_document_readable(d.tenant_id,d.id,$2) AND d.status='active' AND k.status='active' AND a.scan_status='clean' AND g.status='ready' AND g.indexed_count=g.chunk_count
   AND ($4::uuid[] IS NULL OR d.kb_id=ANY($4))
  ) visible WHERE 'read'=ANY(caps) ORDER BY id LIMIT 201`, [member.tenant_id, member.membership_id, ROLE_ACTIONS[member.role], kbs ?? null]);
        if (found.rows.length > MAX_SCOPE)
            fail(422, 'SEARCH_SCOPE_TOO_LARGE');
        return found.rows;
    }
    private async published(client: PoolClient, member: IdentityContext, target: Target) {
        const doc = await this.doc(client, member, target.document_id, 'read');
        const row = (await client.query(`SELECT d.title,d.published_version_id,d.published_generation_id,g.profile_hash,v.version_no,m.* FROM document d JOIN knowledge_base k ON k.tenant_id=d.tenant_id AND k.id=d.kb_id JOIN document_version v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.id=d.published_version_id JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id JOIN index_generation g ON g.tenant_id=d.tenant_id AND g.document_id=d.id AND g.version_id=v.id AND g.id=d.published_generation_id JOIN chunk_manifest m ON m.tenant_id=g.tenant_id AND m.document_id=g.document_id AND m.version_id=g.version_id AND m.parser_version=g.parser_version AND m.chunker_version=g.chunker_version AND m.artifact_sha256=g.chunk_artifact_sha256 WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='active' AND k.status='active' AND a.scan_status='clean' AND g.status='ready' AND g.indexed_count=g.chunk_count AND d.published_version_id=$3 AND d.published_generation_id=$4 AND g.profile_hash=$5 FOR SHARE OF a,g`, [member.tenant_id, target.document_id, target.version_id, target.generation_id, target.profile_hash])).rows[0];
        if (!row)
            fail(404, 'RESOURCE_UNAVAILABLE');
        return { row, download: doc.capabilities.includes('download') };
    }
    private sign(member: IdentityContext, target: Target, chunk: string) {
        if (this.cursorSecret.length < 32)
            fail(503, 'CURSOR_SECRET_REQUIRED');
        const payload = Buffer.from(JSON.stringify({ tenant: member.tenant_id, member: member.membership_id, target, chunk, expires: Date.now() + 600000 })).toString('base64url');
        return `${payload}.${createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')}`;
    }
    private token(member: IdentityContext, token: string, allowExpired = false): {
        target: Target;
        chunk: string;
    } {
        try {
            if (token.length > 4096 || this.cursorSecret.length < 32)
                throw new Error();
            const [payload, signature, extra] = token.split('.');
            if (!payload || !signature || extra)
                throw new Error();
            const expected = createHmac('sha256', this.cursorSecret).update(payload).digest(), actual = Buffer.from(signature, 'base64url');
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
                throw new Error();
            const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
            if (value.tenant !== member.tenant_id || value.member !== member.membership_id || !Number.isFinite(value.expires) || (!allowExpired && value.expires < Date.now()) || !value.target || !value.chunk)
                throw new Error();
            return value;
        }
        catch {
            fail(404, 'RESOURCE_UNAVAILABLE');
        }
    }
    private evidence(member: IdentityContext, target: Target, chunk: KnowledgeChunk, version: number, download: boolean, rank: number | null, score: number | null): SearchEvidence { return { evidence_id: rank === null ? null : `E${rank}`, document_id: target.document_id, version_id: target.version_id, version_no: version, generation_id: target.generation_id, chunk_id: chunk.id, title: target.title, snippet: chunk.text, heading_path: chunk.heading_path, spans: chunk.spans, rank, score, citation_id: this.sign(member, target, chunk.id), download_url: download ? `/api/v1/documents/${target.document_id}/versions/${target.version_id}/content` : null }; }
    async search(current: IdentityContext, input: SearchInput, signal?: AbortSignal, requestId?: string): Promise<SearchResponse> {
        input=await this.resolveSearch(current,input);const result=await this.searchResolved(current,input,signal,requestId);return {...result,meta:{...result.meta,strategy:input.strategy_trace}};
    }
    private async searchResolved(current:IdentityContext,input:SearchInput,signal?:AbortSignal,requestId?:string):Promise<SearchResponse>{
        signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        const searchId = requestId ?? randomUUID();
        if (input.mode === 'lexical')
            return this.lexicalSnapshot(current, input, signal, undefined, (candidates, c, m, targets) => this.assemble(c, m, input, signal!, searchId, candidates, targets.length ? 'no_matching_evidence' : 'no_visible_published_documents'));
        const targets = await this.run(current, (c, m) => this.eligible(c, m, input.kb_ids));
        if (input.mode === 'hybrid')
            return this.hybridSearch(current, input, signal, searchId, targets);
        if (!targets.length)
            return this.run(current, (c, m) => this.assemble(c, m, input, signal!, searchId, [], 'no_visible_published_documents'));
        const candidates = await this.denseCandidates(current, input, signal, targets);
        return this.run(current, (c, m) => this.assemble(c, m, input, signal!, searchId, candidates));
    }
    private async denseCandidates(current: IdentityContext, input: SearchInput, signal: AbortSignal, targets: Target[], depth?: number): Promise<Candidate[]> {
        let profile;
        try {
            if(new Set(targets.map(t=>t.profile_hash)).size!==1)fail(503,'SEARCH_MODEL_SPACE_MIXED');
            profile = indexProfileHash(targets[0]!.profile_hash);
        }
        catch(error) {
            if(error instanceof ResourceError)throw error;
            fail(503, 'SEARCH_NOT_CONFIGURED');
        }
        if (!profile)
            fail(503, 'SEARCH_NOT_CONFIGURED');
        if (targets.some(t => t.profile_hash !== profile.hash))
            fail(503, 'SEARCH_MODEL_SPACE_UNAVAILABLE');
        const dense = new DenseIndex(profile);
        let hits: Array<{
            target: Target;
            chunk: string;
            score: number;
        }> = [];
        try {
            if (signal?.aborted)
                fail(408, 'SEARCH_CANCELLED');
            // Validate the registered space before sending even the query to the model.
            await dense.validate();
            const query = await embedQuery(profile, input.query, profile.hash, signal);
            let offset = 0;
            const lanes = Array.from({ length: Math.min(4, targets.length) }, async () => {
                while (offset < targets.length) {
                    if (signal?.aborted)
                        fail(408, 'SEARCH_CANCELLED');
                    const target = targets[offset++]!;
                    const response = await dense.search(current.tenant_id, target.generation_id, profile.hash, query, depth ?? Math.min(50, input.top_k * 4));
                    if (!response.results.length)
                        fail(503, 'SEARCH_INDEX_INCOMPLETE');
                    for (const hit of response.results) {
                        if (hit.model_space !== profile.hash || hit.generation_id !== target.generation_id || typeof hit.chunk_id !== 'string' || !Number.isFinite(hit.score))
                            fail(503, 'SEARCH_INDEX_INVALID');
                        if (hit.score >= input.min_score)
                            hits.push({ target, chunk: hit.chunk_id, score: Math.max(-1, Math.min(1, hit.score)) });
                    }
                }
            });
            const settled = await Promise.allSettled(lanes);
            for (const result of settled)
                if (result.status === 'rejected')
                    throw result.reason;
        }
        catch (error) {
            if (error instanceof ResourceError)
                throw error;
            if (error instanceof IndexFailure)
                fail(error.code === 'EMBEDDING_INPUT_LIMIT' ? 400 : 503, error.code);
            fail(503, 'SEARCH_UNAVAILABLE');
        }
        finally {
            dense.close();
        }
        hits.sort((a, b) => b.score - a.score || a.target.document_id.localeCompare(b.target.document_id) || a.chunk.localeCompare(b.chunk));
        // Gate B: current authorization and exact published tuple before reading any snippet.
        const candidates: Array<{
            target: Target;
            chunk: KnowledgeChunk;
            score: number;
        }> = [];
        const grouped = new Map<string, typeof hits>();
        for (const hit of hits.slice(0, 160)) {
            const group = grouped.get(hit.target.generation_id) ?? [];
            group.push(hit);
            grouped.set(hit.target.generation_id, group);
        }
        for (const group of grouped.values()) {
            if (signal?.aborted)
                fail(408, 'SEARCH_CANCELLED');
            const target = group[0]!.target;
            try {
                const permit = await this.run(current, (c, m) => this.published(c, m, target)), artifact = await this.readChunks(permit.row, signal);
                const selected = group.map(hit => ({ hit, chunk: artifact.chunks.find(c => c.id === hit.chunk) })).filter(v => v.chunk !== undefined);
                if (input.mode === 'hybrid' && selected.length !== group.length)
                    fail(503, 'SEARCH_INDEX_INVALID');
                const receipts = await this.run(current, async (c, m) => { await this.published(c, m, target); return (await c.query('SELECT chunk_id,retrieval_sha256 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 AND chunk_id=ANY($3)', [m.tenant_id, target.generation_id, selected.map(v => v.chunk!.id)])).rows; });
                if (input.mode === 'hybrid' && selected.some(v => !receipts.some(r => r.chunk_id === v.chunk!.id && r.retrieval_sha256 === v.chunk!.retrieval_sha256)))
                    fail(503, 'SEARCH_INDEX_INCOMPLETE');
                for (const { hit, chunk } of selected)
                    if (receipts.some(r => r.chunk_id === chunk!.id && r.retrieval_sha256 === chunk!.retrieval_sha256))
                        candidates.push({ target, chunk: chunk!, score: hit.score });
            }
            catch (error) {
                if (error instanceof ResourceError && error.status === 404)
                    continue;
                throw error;
            }
        }
        candidates.sort((a, b) => b.score - a.score || a.target.document_id.localeCompare(b.target.document_id) || a.chunk.ordinal - b.chunk.ordinal);
        return candidates;
    }
    private async assemble(client: PoolClient, member: IdentityContext, input: SearchInput, signal: AbortSignal, searchId: string, candidates: Candidate[], emptyReason: SearchResponse['meta']['reason'] = 'no_matching_evidence'): Promise<SearchResponse> {
        const data: SearchEvidence[] = [], sections: string[] = [], seen = new Set<string>();
        let used = 0, budgetSkipped = false, duplicates = 0, budgetCount = 0, documentSkipped = 0, considered = 0;
        const perDocument = new Map<string, number>(), cap = contextOptions(input.context).max_per_document;
        for (const candidate of candidates) {
            if (signal?.aborted)
                fail(408, 'SEARCH_CANCELLED');
            if (data.length >= input.top_k)
                break;
            considered++;
            if (seen.has(candidate.chunk.retrieval_sha256)) {
                duplicates++;
                continue;
            }
            if ((perDocument.get(candidate.target.document_id) ?? 0) >= cap) {
                documentSkipped++;
                continue;
            }
            try {
                const permit = await this.published(client, member, candidate.target);
                const receipt = await client.query('SELECT 1 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 AND chunk_id=$3 AND retrieval_sha256=$4 FOR SHARE', [member.tenant_id, candidate.target.generation_id, candidate.chunk.id, candidate.chunk.retrieval_sha256]);
                if (!receipt.rowCount)
                    continue;
                const section = JSON.stringify({ id: `E${data.length + 1}`, title: permit.row.title, version_no: permit.row.version_no, heading_path: candidate.chunk.heading_path, excerpt: candidate.chunk.text }), cost = section.length + (sections.length ? 1 : 0);
                if (used + cost > input.max_characters) {
                    budgetSkipped = true;
                    budgetCount++;
                    continue;
                }
                const target = { ...candidate.target, title: permit.row.title };
                data.push({ ...this.evidence(member, target, candidate.chunk, permit.row.version_no, permit.download, data.length + 1, candidate.score), ...(candidate.retrieval ? { retrieval: candidate.retrieval } : {}), ...(candidate.rerank ? { rerank: candidate.rerank } : {}) });
                seen.add(candidate.chunk.retrieval_sha256);
                sections.push(section);
                used += cost;
                perDocument.set(candidate.target.document_id, (perDocument.get(candidate.target.document_id) ?? 0) + 1);
            }
            catch (error) {
                if (error instanceof ResourceError && error.status === 404)
                    continue;
                throw error;
            }
        }
        return { data, context: sections.join('\n'), meta: { search_id: searchId, mode: input.mode, degraded: false, candidate_limit: 160, returned: data.length, context_characters: used, max_characters: input.max_characters, ...(input.context || input.rerank?.enabled ? { selection: { considered, selected: data.length, deduplicated: duplicates, skipped_budget: budgetCount, skipped_document_cap: documentSkipped, max_per_document: cap } } : {}), ...(input.mode === 'lexical' ? { lexical: { algorithm: 'bm25-k1-1.2-b-0.75', tokenizer_version: LEXICAL_VERSION, dictionary_hash: DICTIONARY_HASH } } : {}), reason: data.length ? 'ok' : budgetSkipped ? 'context_budget_exhausted' : emptyReason } };
    }
    private async lexicalSnapshot<T>(current: IdentityContext, input: SearchInput, signal: AbortSignal, scope: Target[] | undefined, consume: (candidates: Candidate[], client: PoolClient, member: IdentityContext, targets: Target[]) => Promise<T>): Promise<T> {
        const deadline = Date.now() + 30000;
        lexicalQuery(input.query);
        if (!Number.isFinite(input.min_score) || input.min_score < 0)
            fail(400, 'INVALID_MIN_SCORE');
        return this.run(current, async (client, member) => {
            const targets = scope ?? await this.eligible(client, member, input.kb_ids);
            if (targets.length > 50)
                fail(422, 'LEXICAL_SCOPE_TOO_LARGE');
            const corpus: Array<{
                target: Target;
                chunk: KnowledgeChunk;
                score: number;
            }> = [];
            let bytes = 0;
            // Keep source gates through scoring: DF must never include documents revoked during collection.
            for (const target of targets) {
                if (signal.aborted)
                    fail(408, 'SEARCH_CANCELLED');
                const permit = await this.published(client, member, target);
                bytes += permit.row.artifact_size;
                if (bytes > 33554432 || corpus.length + permit.row.chunk_count > 5000)
                    fail(422, 'LEXICAL_SCOPE_TOO_LARGE');
                const artifact = await this.readChunks(permit.row, signal), receipts = (await client.query('SELECT chunk_id,retrieval_sha256 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 FOR SHARE', [member.tenant_id, target.generation_id])).rows;
                const verified = new Map(receipts.map(r => [r.chunk_id, r.retrieval_sha256]));
                if (artifact.chunks.some(c => verified.get(c.id) !== c.retrieval_sha256))
                    fail(503, 'SEARCH_INDEX_INCOMPLETE');
                for (const chunk of artifact.chunks)
                    corpus.push({ target, chunk, score: 0 });
            }
            const scores = bm25(corpus.map(c => c.chunk.retrieval_text), input.query);
            if (signal.aborted || Date.now() > deadline)
                fail(408, 'SEARCH_CANCELLED');
            for (let i = 0; i < corpus.length; i++)
                corpus[i]!.score = scores[i]!;
            const candidates = corpus.filter(c => c.score > 0 && c.score >= input.min_score).sort((a, b) => b.score - a.score || a.target.document_id.localeCompare(b.target.document_id) || a.chunk.ordinal - b.chunk.ordinal).slice(0, 160);
            return consume(candidates, client, member, targets);
        });
    }
    private async hybridSearch(current: IdentityContext, input: SearchInput, signal: AbortSignal, searchId: string, targets: Target[]): Promise<SearchResponse> {
        const options = hybridOptions(input.hybrid);
        lexicalQuery(input.query);
        if (targets.length > 50)
            fail(422, 'LEXICAL_SCOPE_TOO_LARGE');
        const settled = targets.length ? await Promise.allSettled([
            this.denseCandidates(current, { ...input, min_score: options.dense_min_score }, signal, targets, options.candidate_depth),
            this.lexicalSnapshot(current, { ...input, min_score: options.lexical_min_score }, signal, targets, async (candidates) => candidates)
        ]) : [{ status: 'fulfilled' as const, value: [] as Candidate[] }, { status: 'fulfilled' as const, value: [] as Candidate[] }];
        if (signal.aborted)
            fail(408, 'SEARCH_CANCELLED');
        const channels: NonNullable<SearchResponse['meta']['hybrid']>['channels'] = [], lists: Array<{
            name: 'dense' | 'lexical';
            items: Array<{
                key: string;
                value: Candidate;
                score: number;
            }>;
        }> = [];
        for (const [i, result] of settled.entries()) {
            const name = i === 0 ? 'dense' : 'lexical';
            if (result.status === 'rejected') {
                const error = result.reason;
                if (!(error instanceof ResourceError) || !canDegrade(error))
                    throw error;
                channels.push({ name, status: 'failed', candidates: 0, error_code: error.code });
                continue;
            }
            const seen = new Set<string>(), unique: Candidate[] = [];
            for (const candidate of result.value) {
                const key = candidateKey(candidate);
                if (seen.has(key))
                    continue;
                seen.add(key);
                unique.push(candidate);
                if (unique.length >= options.candidate_depth)
                    break;
            }
            channels.push({ name, status: 'ok', candidates: unique.length });
            lists.push({ name, items: unique.map(value => ({ key: candidateKey(value), value, score: value.score })) });
        }
        const failed = channels.some(c => c.status === 'failed');
        if (!lists.length)
            fail(503, 'HYBRID_CHANNELS_UNAVAILABLE');
        if (failed && !options.allow_partial)
            fail(503, 'HYBRID_CHANNEL_UNAVAILABLE');
        const fused: Candidate[] = reciprocalRankFusion(lists, options.rrf_k).map(r => ({ ...r.value, score: r.score, retrieval: { algorithm: 'rrf' as const, k: options.rrf_k, ranks: r.ranks, contributions: r.contributions, scores: r.scores } }));
        const reranking = input.rerank?.enabled ? await this.rerankCandidates(current, input, signal, targets, fused) : null;
        // Dispatch and final assembly each recheck the complete original scope.
        return this.run(current, async (client, member) => {
            for (const target of targets) {
                if (signal.aborted)
                    fail(408, 'SEARCH_CANCELLED');
                await this.published(client, member, target);
            }
            if (signal.aborted)
                fail(408, 'SEARCH_CANCELLED');
            if (input.rerank?.enabled)
                for (const candidate of fused.slice(0, rerankOptions(input.rerank).top_n)) {
                    const r = await client.query('SELECT 1 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 AND chunk_id=$3 AND retrieval_sha256=$4 FOR SHARE', [member.tenant_id, candidate.target.generation_id, candidate.chunk.id, candidate.chunk.retrieval_sha256]);
                    if (!r.rowCount)
                        fail(503, 'SEARCH_INDEX_INCOMPLETE');
                }
            const result = await this.assemble(client, member, input, signal, searchId, reranking?.candidates ?? fused, targets.length ? 'no_matching_evidence' : 'no_visible_published_documents');
            result.meta.degraded = failed || reranking?.meta.status === 'fallback';
            result.meta.hybrid = { algorithm: 'rrf', k: options.rrf_k, candidate_depth: options.candidate_depth, allow_partial: options.allow_partial, channels };
            if (reranking)
                result.meta.rerank = reranking.meta;
            return result;
        });
    }
    private async rerankCandidates(current: IdentityContext, input: SearchInput, signal: AbortSignal, targets: Target[], candidates: Candidate[]) {
        const options = rerankOptions(input.rerank), top = candidates.slice(0, options.top_n), inputs = rerankInputs(top.map(c => c.chunk.retrieval_text), options.max_input_characters), start = performance.now();
        const meta: RerankMeta = { status: 'skipped', model: null, max_input_characters: options.max_input_characters, top_n: options.top_n, received_candidates: candidates.length, sent_candidates: 0, truncated_documents: 0, input_characters: 0, duration_ms: 0, tokens: null, cost: null };
        if (!top.length) {
            meta.reason = 'NO_CANDIDATES';
            return { candidates, meta };
        }
        const key = current.tenant_id + ':' + current.membership_id;
        let held = false;
        try {
            let profile;
            try {
                profile = rerankProfile();
            }
            catch {
                throw new RerankFailure('RERANK_INVALID_CONFIG');
            }
            if (!profile)
                throw new RerankFailure('RERANK_NOT_CONFIGURED');
            meta.model = { name: profile.model, revision: profile.revision, profile_hash: profile.hash };
            if (this.reranking.has(key) || this.reranking.size >= 2)
                throw new RerankFailure('RERANK_BUSY');
            this.reranking.add(key);
            held = true;
            const dispatch = await this.run(current, async (client, member) => {
                for (const target of targets)
                    await this.published(client, member, target);
                for (const candidate of top) {
                    const receipt = await client.query('SELECT 1 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 AND chunk_id=$3 AND retrieval_sha256=$4 FOR SHARE', [member.tenant_id, candidate.target.generation_id, candidate.chunk.id, candidate.chunk.retrieval_sha256]);
                    if (!receipt.rowCount)
                        fail(503, 'SEARCH_INDEX_INCOMPLETE');
                }
                if (signal.aborted)
                    fail(408, 'SEARCH_CANCELLED');
                meta.sent_candidates = top.length;
                meta.truncated_documents = inputs.filter(i => i.truncated).length;
                meta.input_characters = inputs.reduce((n, i) => n + Array.from(i.text).length, 0);
                const pending = rerank(profile!, input.query, inputs.map(i => i.text), signal);
                void pending.catch(() => { });
                return { pending };
            });
            const result = await dispatch.pending;
            meta.status = 'applied';
            meta.tokens = result.tokens;
            return { candidates: result.rows.map((row, rank) => ({ ...top[row.index]!, rerank: { rank: rank + 1, score: row.score, original_rank: row.index + 1, truncated: inputs[row.index]!.truncated } })), meta };
        }
        catch (error) {
            if (!(error instanceof RerankFailure))
                throw error;
            if (options.failure_policy === 'fail')
                fail(503, error.code);
            meta.status = 'fallback';
            meta.reason = error.code;
            return { candidates, meta };
        }
        finally {
            meta.duration_ms = performance.now() - start;
            if (held)
                this.reranking.delete(key);
        }
    }
    /** Internal gate for server-produced evidence only; never accepts a client context.
     * Persisted signed proofs may bypass TTL, but still pass every current ACL/publication/hash gate. */
    protected withEvidence<T>(current: IdentityContext, evidence: SearchEvidence[], action: (fresh: SearchEvidence[], client: PoolClient) => T | Promise<T>, allowExpired = false): Promise<T> {
        return this.run(current, async (client, member) => {
            const fresh: SearchEvidence[] = [];
            // A single transaction retains all source locks until the dispatch/assembly boundary.
            for (const item of [...evidence].sort((a, b) => a.document_id.localeCompare(b.document_id) || a.chunk_id.localeCompare(b.chunk_id))) {
                const parsed = this.token(member, item.citation_id, allowExpired);
                if (parsed.target.document_id !== item.document_id || parsed.target.version_id !== item.version_id || parsed.target.generation_id !== item.generation_id || parsed.chunk !== item.chunk_id)
                    fail(404, 'RESOURCE_UNAVAILABLE');
                const permit = await this.published(client, member, parsed.target), receipt = await client.query('SELECT 1 FROM index_receipt r JOIN knowledge_chunk c ON c.tenant_id=r.tenant_id AND c.id=r.chunk_id AND c.retrieval_sha256=r.retrieval_sha256 WHERE r.tenant_id=$1 AND r.generation_id=$2 AND r.chunk_id=$3 AND c.version_id=$4 AND c.text_sha256=$5 AND c.parser_version=$6 AND c.chunker_version=$7 FOR SHARE OF r,c', [member.tenant_id, item.generation_id, item.chunk_id, item.version_id, createHash('sha256').update(item.snippet).digest('hex'), permit.row.parser_version, permit.row.chunker_version]);
                if (!receipt.rowCount)
                    fail(404, 'RESOURCE_UNAVAILABLE');
                fresh.push({ ...item, title: permit.row.title, version_no: permit.row.version_no, citation_id: this.sign(member, { ...parsed.target, title: permit.row.title }, item.chunk_id), download_url: permit.download ? `/api/v1/documents/${item.document_id}/versions/${item.version_id}/content` : null });
            }
            return action(evidence.map(item => fresh.find(f => f.evidence_id === item.evidence_id)!), client);
        });
    }
    async readCitation(current: IdentityContext, token: string): Promise<SearchEvidence> {
        const parsed = await this.run(current, async (client, member) => { const data = this.token(member, token), permit = await this.published(client, member, data.target); return { ...data, row: permit.row }; }), artifact = await this.readChunks(parsed.row), chunk = artifact.chunks.find(c => c.id === parsed.chunk);
        if (!chunk)
            fail(404, 'RESOURCE_UNAVAILABLE');
        return this.run(current, async (client, member) => {
            this.token(member, token);
            const permit = await this.published(client, member, parsed.target);
            const receipt = await client.query('SELECT 1 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 AND chunk_id=$3 AND retrieval_sha256=$4 FOR SHARE', [member.tenant_id, parsed.target.generation_id, chunk.id, chunk.retrieval_sha256]);
            if (!receipt.rowCount)
                fail(404, 'RESOURCE_UNAVAILABLE');
            return this.evidence(member, { ...parsed.target, title: permit.row.title }, chunk, permit.row.version_no, permit.download, null, null);
        });
    }
}
