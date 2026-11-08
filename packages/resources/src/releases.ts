import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { IdentityContext } from '@zhiheng/contracts';
import { ConnectorStore } from './connectors';
import { fail, ResourceError } from './policy';
import { docEtag, type ListInput } from './store';
import { digest, embedQuery, type EmbeddingProfile } from './embedding';
import { indexProfile, indexProfileHash, indexProfiles } from './index-profiles';
import { DenseIndex } from './dense-index';
import { storageKey } from './lifecycle-policy';
import { LEXICAL_VERSION, DICTIONARY_HASH } from './lexical';
const releaseEtag = (r: any) => `"release:${r.id}:${r.row_version}"`;
const keyHash = (key: string) => { if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    fail(400, 'IDEMPOTENCY_KEY_REQUIRED'); return digest(key); };
const view = (r: any) => ({ id: r.id, kb_id: r.kb_id, profile_ref: r.profile_ref, profile_hash: r.profile_hash, status: r.status, row_version: r.row_version, coverage_hash: r.coverage_hash, proof: r.proof, review_hash: r.review_hash, created_at: r.created_at, updated_at: r.updated_at, etag: releaseEtag(r) });
type VerifiedGeneration = {
    doc: string;
    version: string;
    id: string;
    signature: string;
    profile_hash: string;
};
export interface ReleaseProbe {
    query: string;
    expected_document_id: string;
}
export class ReleaseStore extends ConnectorStore {
    private profile(ref: string) { try {
        return indexProfile(ref);
    }
    catch {
        fail(503, 'INDEX_PROFILE_UNAVAILABLE');
    } }
    private async permission(c: PoolClient, m: IdentityContext, kb: string, lock = false) { const k = await this.kb(c, m, kb, 'manage', lock); if (!['read', 'write', 'publish'].every(a => k.capabilities.includes(a as never)))
        fail(404, 'RESOURCE_UNAVAILABLE'); return k; }
    private releaseMatch(actual: string, expected?: string) { if (!expected)
        fail(428, 'IF_MATCH_REQUIRED'); if (actual !== expected)
        fail(412, 'RESOURCE_VERSION_CHANGED'); }
    private async release(c: PoolClient, m: IdentityContext, id: string, lock = false) { const r = (await c.query('SELECT * FROM index_release WHERE tenant_id=$1 AND id=$2', [m.tenant_id, id])).rows[0]; if (!r)
        fail(404, 'RESOURCE_UNAVAILABLE'); await this.permission(c, m, r.kb_id, lock); return (await c.query(`SELECT * FROM index_release WHERE tenant_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [m.tenant_id, id])).rows[0]; }
    private async request(c: PoolClient, m: IdentityContext, key: string, payload: unknown) { const kh = keyHash(key), ph = digest(JSON.stringify(payload)); await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`publication:${m.tenant_id}:${m.membership_id}:${kh}`]); const old = (await c.query('SELECT * FROM publication_request WHERE tenant_id=$1 AND member_id=$2 AND key_hash=$3', [m.tenant_id, m.membership_id, kh])).rows[0]; if (old && old.payload_hash !== ph)
        fail(409, 'IDEMPOTENCY_CONFLICT'); return { kh, ph, old: old?.result }; }
    private async remember(c: PoolClient, m: IdentityContext, key: any, result: any) { await c.query('INSERT INTO publication_request VALUES($1,$2,$3,$4,$5)', [m.tenant_id, m.membership_id, key.kh, key.ph, JSON.stringify(result)]); return result; }
    private async documents(c: PoolClient, m: IdentityContext, kb: string) { const rows = (await c.query("SELECT id,published_version_id AS version_id,published_generation_id AS generation_id,row_version,policy_version FROM document WHERE tenant_id=$1 AND kb_id=$2 AND status='active' AND published_version_id IS NOT NULL AND published_generation_id IS NOT NULL ORDER BY id LIMIT 201", [m.tenant_id, kb])).rows; if (rows.length > 200)
        fail(422, 'RELEASE_SCOPE_TOO_LARGE'); for (const d of rows) {
        await this.doc(c, m, d.id, 'read');
        await this.doc(c, m, d.id, 'write');
        await this.doc(c, m, d.id, 'publish');
    } return rows; }
    private async items(c: PoolClient, m: IdentityContext, id: string) { return (await c.query('SELECT * FROM index_release_item WHERE tenant_id=$1 AND release_id=$2 ORDER BY document_id', [m.tenant_id, id])).rows; }
    private async publicationEvent(c: PoolClient, m: IdentityContext, kb: string, doc: string | null, release: string | null, action: string, from: any, to: any, proof: string) { await c.query('INSERT INTO publication_event(tenant_id,kb_id,document_id,release_id,member_id,action,from_version_id,from_generation_id,to_version_id,to_generation_id,proof_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [m.tenant_id, kb, doc, release, m.membership_id, action, from?.version_id ?? null, from?.generation_id ?? null, to?.version_id ?? null, to?.generation_id ?? null, proof]); }
    configuredProfiles(current: IdentityContext, kb: string) { return this.run(current, async (c, m) => { await this.permission(c, m, kb); return [...indexProfiles()].map(([ref, p]) => ({ ref, hash: p.hash, model: p.model, revision: p.revision, dimension: p.dimension })); }); }
    listReleases(current: IdentityContext, kb: string, input: ListInput) { return this.run(current, async (c, m) => { await this.permission(c, m, kb); const scope = super.scope(m, input, `releases:${kb}`), after = this.cursor(input, scope), rows = (await c.query('SELECT * FROM index_release WHERE tenant_id=$1 AND kb_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5', [m.tenant_id, kb, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1])).rows, p = this.page(rows, input, scope); return { ...p, data: p.data.map(view) }; }); }
    getRelease(current: IdentityContext, id: string) { return this.run(current, async (c, m) => { const r = await this.release(c, m, id); return { ...view(r), items: await this.items(c, m, id), events: (await c.query('SELECT action,document_id,from_version_id,from_generation_id,to_version_id,to_generation_id,proof_hash,created_at FROM publication_event WHERE tenant_id=$1 AND release_id=$2 ORDER BY seq DESC LIMIT 100', [m.tenant_id, id])).rows }; }); }
    createRelease(current: IdentityContext, kb: string, ref: string, key: string, requestId: string) { const profile = this.profile(ref); return this.run(current, async (c, m) => { const req = await this.request(c, m, key, ['release', kb, profile.hash]); await this.permission(c, m, kb, true); if (req.old)
        return req.old; if ((await c.query("SELECT 1 FROM index_release WHERE tenant_id=$1 AND kb_id=$2 AND status IN ('building','verified')", [m.tenant_id, kb])).rowCount)
        fail(409, 'RELEASE_ALREADY_BUILDING'); const docs = await this.documents(c, m, kb); if (!docs.length)
        fail(409, 'NO_PUBLISHED_DOCUMENTS'); const r = (await c.query("INSERT INTO index_release(tenant_id,id,kb_id,owner_id,profile_ref,profile_hash,status) VALUES($1,$2,$3,$4,$5,$6,'building') RETURNING *", [m.tenant_id, randomUUID(), kb, m.membership_id, ref, profile.hash])).rows[0]; for (const d of docs)
        await c.query('INSERT INTO index_release_item(tenant_id,release_id,document_id,version_id,baseline_generation_id,build_key) VALUES($1,$2,$3,$4,$5,$6)', [m.tenant_id, r.id, d.id, d.version_id, d.generation_id, randomUUID()]); await this.audit(c, m, kb, 'index_release.created', requestId); return this.remember(c, m, req, view(r)); }); }
    async reconcileRelease(current: IdentityContext, id: string, etag: string | undefined, requestId: string) {
        const input = await this.run(current, async (c, m) => {
            const r = await this.release(c, m, id, true);
            this.releaseMatch(releaseEtag(r), etag);
            if (!['building', 'verified'].includes(r.status))
                fail(409, 'RELEASE_NOT_BUILDING');
            if (this.profile(r.profile_ref).hash !== r.profile_hash)
                fail(409, 'INDEX_PROFILE_CHANGED');
            const docs = await this.documents(c, m, r.kb_id), old = await this.items(c, m, id);
            await c.query('DELETE FROM index_release_item WHERE tenant_id=$1 AND release_id=$2 AND NOT(document_id=ANY($3::uuid[]))', [m.tenant_id, id, docs.map(d => d.id)]);
            for (const d of docs) {
                const previous = old.find(i => i.document_id === d.id);
                if (!previous || previous.version_id !== d.version_id || previous.baseline_generation_id !== d.generation_id) {
                    await c.query('INSERT INTO index_release_item(tenant_id,release_id,document_id,version_id,baseline_generation_id,build_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,release_id,document_id) DO UPDATE SET version_id=EXCLUDED.version_id,baseline_generation_id=EXCLUDED.baseline_generation_id,candidate_generation_id=NULL,build_key=EXCLUDED.build_key,error_code=NULL', [m.tenant_id, id, d.id, d.version_id, d.generation_id, randomUUID()]);
                }
            }
            await c.query("UPDATE index_release SET status='building',proof=NULL,coverage_hash=NULL,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [m.tenant_id, id]);
            await this.audit(c, m, r.kb_id, 'index_release.catchup', requestId);
            return { r, items: await this.items(c, m, id) };
        });
        for (const i of input.items) {
            try {
                await this.rebuildIndex(current, i.document_id, i.version_id, i.build_key, true, requestId, input.r.profile_ref);
                await this.run(current, async (c, m) => { const r = await this.release(c, m, id, true); if (r.status !== 'building')
                    return; await c.query('UPDATE index_release_item SET error_code=NULL WHERE tenant_id=$1 AND release_id=$2 AND document_id=$3 AND build_key=$4', [m.tenant_id, id, i.document_id, i.build_key]); });
            }
            catch (e) {
                const code = e instanceof ResourceError ? e.code : 'INDEX_BUILD_UNAVAILABLE';
                await this.run(current, async (c, m) => { await this.release(c, m, id); await c.query('UPDATE index_release_item SET error_code=$4 WHERE tenant_id=$1 AND release_id=$2 AND document_id=$3 AND build_key=$5', [m.tenant_id, id, i.document_id, code, i.build_key]); });
            }
        }
        return this.getRelease(current, id);
    }
    // Local SQL metadata and source gates are checked both before and after external storage/model I/O.
    private async generation(c: PoolClient, m: IdentityContext, doc: string, version: string, generation: string) { const d = await this.doc(c, m, doc, 'read'); await this.doc(c, m, doc, 'publish'); const row = (await c.query(`SELECT g.*,v.content_sha256,a.scan_status,m.object_key,m.object_version,m.artifact_size,m.artifact_sha256,m.source_sha256,m.parsed_artifact_sha256,b.storage_key FROM index_generation g JOIN document_version v ON v.tenant_id=g.tenant_id AND v.document_id=g.document_id AND v.id=g.version_id JOIN source_asset a ON a.tenant_id=v.tenant_id AND a.id=v.source_asset_id JOIN chunk_manifest m ON m.tenant_id=g.tenant_id AND m.version_id=g.version_id AND m.parser_version=g.parser_version AND m.chunker_version=g.chunker_version AND m.artifact_sha256=g.chunk_artifact_sha256 JOIN vector_binding b ON b.tenant_id=g.tenant_id AND b.generation_id=g.id WHERE g.tenant_id=$1 AND g.document_id=$2 AND g.version_id=$3 AND g.id=$4 AND g.status='ready' AND g.indexed_count=g.chunk_count FOR SHARE OF g,a,b`, [m.tenant_id, doc, version, generation])).rows[0]; if (!row || row.scan_status !== 'clean' || row.chunk_count < 1 || JSON.stringify(row.required_artifacts) !== '["dense"]')
        fail(409, 'PUBLICATION_NOT_READY'); if ((await c.query('SELECT 1 FROM document_tombstone WHERE tenant_id=$1 AND document_id=$2', [m.tenant_id, doc])).rowCount)
        fail(404, 'RESOURCE_UNAVAILABLE'); const receipts = (await c.query('SELECT r.chunk_id,r.retrieval_sha256,k.retrieval_sha256 AS expected FROM index_receipt r LEFT JOIN knowledge_chunk k ON k.tenant_id=r.tenant_id AND k.id=r.chunk_id AND k.version_id=$3 AND k.parser_version=$4 AND k.chunker_version=$5 WHERE r.tenant_id=$1 AND r.generation_id=$2 ORDER BY r.chunk_id FOR SHARE OF r', [m.tenant_id, generation, version, row.parser_version, row.chunker_version])).rows; if (receipts.length !== row.chunk_count || receipts.some(r => r.retrieval_sha256 !== r.expected))
        fail(409, 'INDEX_RECEIPTS_INCOMPLETE'); return { ...row, document_row_version: d.row_version, kb_policy_version: d.kb_policy_version, document_policy_version: d.policy_version, receipts_hash: digest(JSON.stringify(receipts)) }; }
    private async completePublishedJob(c: PoolClient, m: IdentityContext, version: string, generation: string) { const job = (await c.query("SELECT j.* FROM ingestion_job j JOIN ingestion_checkpoint p ON p.tenant_id=j.tenant_id AND p.job_id=j.id AND p.step='dense_index' AND p.generation_id=$3 WHERE j.tenant_id=$1 AND j.version_id=$2 AND j.status='waiting_dependency' AND j.stage='awaiting_publication' FOR UPDATE OF j", [m.tenant_id, version, generation])).rows[0]; if (job)
        await this.change(c, job, { status: 'succeeded', stage: 'published', error_code: null, dead_letter: false }); }
    private signature(g: any) { return digest(JSON.stringify([g.id, g.version_id, g.profile_hash, g.config_hash, g.chunk_artifact_sha256, g.receipts_hash, g.document_row_version, g.kb_policy_version, g.document_policy_version, g.scan_status, g.storage_key])); }
    private async verifyGeneration(current: IdentityContext, doc: string, version: string, id: string) { const before = await this.run(current, (c, m) => this.generation(c, m, doc, version, id)); let profile: EmbeddingProfile; try {
        profile = indexProfileHash(before.profile_hash);
    }
    catch {
        fail(503, 'INDEX_PROFILE_UNAVAILABLE');
    } if (before.storage_key !== storageKey(profile!.milvusAddress))
        fail(409, 'VECTOR_STORAGE_BINDING_REQUIRED'); const chunks = await this.readChunks(before), dense = new DenseIndex(profile!); try {
        await dense.validate();
        for (let offset = 0; offset < chunks.chunks.length; offset += 16) {
            const batch = chunks.chunks.slice(offset, offset + 16), cache = (await this.pool!.query("SELECT text_sha256,vector FROM embedding_entry WHERE tenant_id=$1 AND profile_hash=$2 AND text_sha256=ANY($3) AND status='ready'", [current.tenant_id, profile!.hash, batch.map(c => c.retrieval_sha256)])).rows;
            const rows = batch.map(c => { const e = cache.find(e => e.text_sha256 === c.retrieval_sha256); if (!e)
                fail(409, 'INDEX_CACHE_MISSING'); return { id: digest(`${current.tenant_id}:${id}:${c.id}`), tenant_id: current.tenant_id, generation_id: id, model_space: profile!.hash, retrieval_sha256: c.retrieval_sha256, vector: e.vector }; });
            if (!await dense.verify(rows))
                fail(409, 'INDEX_READBACK_FAILED');
        }
    }
    finally {
        dense.close();
    } const after = await this.run(current, (c, m) => this.generation(c, m, doc, version, id)); if (this.signature(before) !== this.signature(after))
        fail(409, 'PUBLICATION_SCOPE_CHANGED'); return { doc, version, id, signature: this.signature(after), profile_hash: after.profile_hash }; }
    private async snapshot(c: PoolClient, m: IdentityContext, r: any) { const docs = await this.documents(c, m, r.kb_id), items = await this.items(c, m, r.id); if (!docs.length || docs.length !== items.length || docs.some(d => !items.some(i => i.document_id === d.id && i.version_id === d.version_id && i.baseline_generation_id === d.generation_id)))
        fail(409, 'RELEASE_CATCHUP_REQUIRED'); return { docs, items, hash: digest(JSON.stringify(docs)) }; }
    private async rankProbe(current: IdentityContext, targets: Array<{
        doc: string;
        version: string;
        id: string;
        profile_hash: string;
    }>, query: string) { const spaces = [...new Set(targets.map(t => t.profile_hash))]; if (spaces.length !== 1)
        fail(409, 'RELEASE_MODEL_SPACE_MIXED'); const profile = indexProfileHash(spaces[0]!), dense = new DenseIndex(profile); try {
        await dense.validate();
        const vector = await embedQuery(profile, query, profile.hash);
        const scores: Array<{
            document_id: string;
            score: number;
        }> = [];
        for (const t of targets) {
            await this.run(current, async (c, m) => { await this.doc(c, m, t.doc, 'read'); await this.doc(c, m, t.doc, 'publish'); });
            const hits = await dense.search(current.tenant_id, t.id, profile.hash, vector, 5);
            if (!hits.results.length)
                fail(409, 'INDEX_READBACK_FAILED');
            let best = -Infinity;
            for (const h of hits.results) {
                if (h.model_space !== profile.hash || h.generation_id !== t.id || !Number.isFinite(h.score) || (await this.pool!.query('SELECT 1 FROM index_receipt WHERE tenant_id=$1 AND generation_id=$2 AND chunk_id=$3', [current.tenant_id, t.id, h.chunk_id])).rowCount !== 1)
                    fail(409, 'INDEX_READBACK_FAILED');
                best = Math.max(best, h.score);
            }
            scores.push({ document_id: t.doc, score: best });
        }
        return scores.sort((a, b) => b.score - a.score || a.document_id.localeCompare(b.document_id)).map(s => s.document_id);
    }
    finally {
        dense.close();
    } }
    async verifyRelease(current: IdentityContext, id: string, etag: string | undefined, probes: ReleaseProbe[], requestId: string) {
        if (!Array.isArray(probes) || !probes.length || probes.length > 20 || probes.some(p => typeof p.query !== 'string' || !p.query.trim() || p.query.length > 1200 || !/^[a-f0-9-]{36}$/.test(p.expected_document_id)))
            fail(400, 'INVALID_RELEASE_PROBES');
        const input = await this.run(current, async (c, m) => { const r = await this.release(c, m, id); this.releaseMatch(releaseEtag(r), etag); if (!['building', 'verified'].includes(r.status))
            fail(409, 'RELEASE_NOT_BUILDING'); if (this.profile(r.profile_ref).hash !== r.profile_hash)
            fail(409, 'INDEX_PROFILE_CHANGED'); const scope = await this.snapshot(c, m, r); if (probes.some(p => !scope.docs.some(d => d.id === p.expected_document_id)))
            fail(400, 'PROBE_OUTSIDE_RELEASE'); const candidates = []; for (const i of scope.items) {
            const g = (await c.query("SELECT id FROM index_generation WHERE tenant_id=$1 AND document_id=$2 AND version_id=$3 AND profile_hash=$4 AND status='ready' AND created_at>=$5 AND id<>$6 ORDER BY generation_no DESC LIMIT 1", [m.tenant_id, i.document_id, i.version_id, r.profile_hash, r.created_at, i.baseline_generation_id])).rows[0];
            if (!g)
                fail(409, 'RELEASE_BUILD_INCOMPLETE');
            candidates.push({ ...i, candidate_generation_id: g.id });
        } return { r, scope, candidates }; });
        const candidates: VerifiedGeneration[] = [], baseline: VerifiedGeneration[] = [];
        for (const i of input.candidates) {
            candidates.push(await this.verifyGeneration(current, i.document_id, i.version_id, i.candidate_generation_id));
            baseline.push(await this.verifyGeneration(current, i.document_id, i.version_id, i.baseline_generation_id));
        }
        const rows: Array<{
            query_hash: string;
            expected_document_id: string;
            baseline_rank: number | null;
            candidate_rank: number | null;
            baseline_ms: number;
            candidate_ms: number;
        }> = [];
        for (const probe of probes) {
            const start = Date.now(), old = await this.rankProbe(current, baseline, probe.query), oldMs = Date.now() - start, now = Date.now(), next = await this.rankProbe(current, candidates, probe.query), rank = (values: string[]) => { const n = values.indexOf(probe.expected_document_id) + 1; return n > 0 && n <= 5 ? n : null; };
            rows.push({ query_hash: digest(probe.query), expected_document_id: probe.expected_document_id, baseline_rank: rank(old), candidate_rank: rank(next), baseline_ms: oldMs, candidate_ms: Date.now() - now });
        }
        const metric = (key: 'baseline_rank' | 'candidate_rank') => ({ recall_at_5: rows.filter(r => r[key] !== null).length / rows.length, mrr: rows.reduce((n, r) => n + (r[key] ? 1 / r[key]! : 0), 0) / rows.length });
        const old = metric('baseline_rank'), next = metric('candidate_rank'), quality = next.recall_at_5 >= old.recall_at_5 && next.mrr >= old.mrr;
        return this.run(current, async (c, m) => { const r = await this.release(c, m, id, true); this.releaseMatch(releaseEtag(r), etag); const scope = await this.snapshot(c, m, r); if (scope.hash !== input.scope.hash)
            fail(409, 'PUBLICATION_SCOPE_CHANGED'); for (const target of [...baseline, ...candidates])
            if (this.signature(await this.generation(c, m, target.doc, target.version, target.id)) !== target.signature)
                fail(409, 'PUBLICATION_SCOPE_CHANGED'); const proof = { coverage_hash: scope.hash, candidates, baseline, lexical: { version: LEXICAL_VERSION, dictionary_hash: DICTIONARY_HASH, mode: 'authorized-on-read-bm25' }, evaluation: { rows, baseline: old, candidate: next, non_regression: quality }, verified_at: new Date().toISOString() }; for (const target of candidates)
            await c.query('UPDATE index_release_item SET candidate_generation_id=$4,error_code=NULL WHERE tenant_id=$1 AND release_id=$2 AND document_id=$3', [m.tenant_id, id, target.doc, target.id]); const updated = (await c.query("UPDATE index_release SET status=$3,proof=$4,coverage_hash=$5,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [m.tenant_id, id, quality ? 'verified' : 'building', JSON.stringify(proof), scope.hash])).rows[0]; await this.audit(c, m, r.kb_id, 'index_release.verified', requestId); return view(updated); });
    }
    private review(note: string, reviewed: boolean) { if (!reviewed || typeof note !== 'string' || note.trim().length < 10 || note.length > 2000)
        fail(400, 'QUALITY_REVIEW_REQUIRED'); return digest(note.trim()); }
    async activateRelease(current: IdentityContext, id: string, etag: string | undefined, key: string, note: string, reviewed: boolean, requestId: string) {
        const review = this.review(note, reviewed), input = await this.run(current, async (c, m) => { const req = await this.request(c, m, key, ['activate', id, review]); const r = await this.release(c, m, id); if (req.old)
            return { replay: req.old }; this.releaseMatch(releaseEtag(r), etag); if (r.status !== 'verified' || !r.proof?.evaluation?.non_regression || Date.parse(r.proof.verified_at) < Date.now() - 600000)
            fail(409, 'RELEASE_VERIFICATION_REQUIRED'); const scope = await this.snapshot(c, m, r); if (scope.hash !== r.coverage_hash)
            fail(409, 'RELEASE_CATCHUP_REQUIRED'); return { r }; });
        if (input.replay)
            return input.replay;
        for (const t of input.r.proof.candidates) {
            const check = await this.verifyGeneration(current, t.doc, t.version, t.id);
            if (check.signature !== t.signature)
                fail(409, 'PUBLICATION_SCOPE_CHANGED');
        }
        return this.run(current, async (c, m) => { const req = await this.request(c, m, key, ['activate', id, review]), r = await this.release(c, m, id, true); if (req.old)
            return req.old; this.releaseMatch(releaseEtag(r), etag); if (r.status !== 'verified')
            fail(409, 'RELEASE_VERIFICATION_REQUIRED'); if (this.profile(r.profile_ref).hash !== r.profile_hash)
            fail(409, 'INDEX_PROFILE_CHANGED'); const scope = await this.snapshot(c, m, r); if (scope.hash !== r.coverage_hash)
            fail(409, 'RELEASE_CATCHUP_REQUIRED'); for (const t of r.proof.candidates) {
            if (this.signature(await this.generation(c, m, t.doc, t.version, t.id)) !== t.signature)
                fail(409, 'PUBLICATION_SCOPE_CHANGED');
            const from = scope.docs.find(d => d.id === t.doc);
            await c.query('UPDATE document SET published_generation_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2', [m.tenant_id, t.doc, t.id]);
            await this.completePublishedJob(c, m, t.version, t.id);
            await this.publicationEvent(c, m, r.kb_id, t.doc, id, 'activate', { version_id: t.version, generation_id: from.generation_id }, { version_id: t.version, generation_id: t.id }, digest(JSON.stringify(r.proof)));
        } await c.query('UPDATE knowledge_base SET active_index_profile_hash=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2', [m.tenant_id, r.kb_id, r.profile_hash]); const updated = (await c.query("UPDATE index_release SET status='active',review_hash=$3,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [m.tenant_id, id, review])).rows[0]; await this.audit(c, m, r.kb_id, 'index_release.activated', requestId); return this.remember(c, m, req, view(updated)); });
    }
    async rollbackRelease(current: IdentityContext, id: string, etag: string | undefined, key: string, note: string, reviewed: boolean, requestId: string) {
        const review = this.review(note, reviewed), input = await this.run(current, async (c, m) => { const req = await this.request(c, m, key, ['rollback', id, review]); const r = await this.release(c, m, id); if (req.old)
            return { replay: req.old }; this.releaseMatch(releaseEtag(r), etag); if (r.status !== 'active')
            fail(409, 'RELEASE_NOT_ACTIVE'); const docs = await this.documents(c, m, r.kb_id), items = await this.items(c, m, id); if (docs.some(d => !items.some(i => i.document_id === d.id && i.version_id === d.version_id && i.candidate_generation_id === d.generation_id)))
            fail(409, 'ROLLBACK_SCOPE_CHANGED'); return { r, docs, items }; });
        if (input.replay)
            return input.replay;
        const verified: VerifiedGeneration[] = [];
        for (const d of input.docs!) {
            const item = input.items!.find(i => i.document_id === d.id);
            verified.push(await this.verifyGeneration(current, d.id, d.version_id, item.baseline_generation_id));
        }
        return this.run(current, async (c, m) => { const req = await this.request(c, m, key, ['rollback', id, review]), r = await this.release(c, m, id, true); if (req.old)
            return req.old; this.releaseMatch(releaseEtag(r), etag); if (r.status !== 'active')
            fail(409, 'RELEASE_NOT_ACTIVE'); const docs = await this.documents(c, m, r.kb_id); if (JSON.stringify(docs) !== JSON.stringify(input.docs))
            fail(409, 'ROLLBACK_SCOPE_CHANGED'); for (const t of verified) {
            if (this.signature(await this.generation(c, m, t.doc, t.version, t.id)) !== t.signature)
                fail(409, 'PUBLICATION_SCOPE_CHANGED');
            const from = docs.find(d => d.id === t.doc);
            await c.query('UPDATE document SET published_generation_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2', [m.tenant_id, t.doc, t.id]);
            await this.publicationEvent(c, m, r.kb_id, t.doc, id, 'rollback', { version_id: t.version, generation_id: from.generation_id }, { version_id: t.version, generation_id: t.id }, digest(JSON.stringify(verified)));
        } await c.query('UPDATE knowledge_base SET active_index_profile_hash=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2', [m.tenant_id, r.kb_id, r.proof.baseline[0].profile_hash]); const updated = (await c.query("UPDATE index_release SET status='rolled_back',review_hash=$3,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [m.tenant_id, id, review])).rows[0]; await this.audit(c, m, r.kb_id, 'index_release.rolled_back', requestId); return this.remember(c, m, req, view(updated)); });
    }
    cancelRelease(current: IdentityContext, id: string, etag: string | undefined, requestId: string) { return this.run(current, async (c, m) => { const r = await this.release(c, m, id, true); this.releaseMatch(releaseEtag(r), etag); if (!['building', 'verified'].includes(r.status))
        fail(409, 'RELEASE_NOT_BUILDING'); const updated = (await c.query("UPDATE index_release SET status='cancelled',proof=NULL,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [m.tenant_id, id])).rows[0]; await this.audit(c, m, r.kb_id, 'index_release.cancelled', requestId); return view(updated); }); }
    async publishDocument(current: IdentityContext, doc: string, version: string, generation: string, etag: string | undefined, key: string, note: string, reviewed: boolean, requestId: string) { const review = this.review(note, reviewed), payload = ['publish', doc, version, generation, review]; const replay = await this.run(current, async (c, m) => { const req = await this.request(c, m, key, payload); await this.doc(c, m, doc, 'publish'); await this.doc(c, m, doc, 'read'); return req.old; }); if (replay)
        return replay; const check = await this.verifyGeneration(current, doc, version, generation); return this.run(current, async (c, m) => { const req = await this.request(c, m, key, payload), d = await this.doc(c, m, doc, 'publish', true); await this.doc(c, m, doc, 'read'); if (req.old)
        return req.old; this.releaseMatch(docEtag(d), etag); const g = await this.generation(c, m, doc, version, generation); if (this.signature(g) !== check.signature)
        fail(409, 'PUBLICATION_SCOPE_CHANGED'); const active = (await c.query('SELECT active_index_profile_hash FROM knowledge_base WHERE tenant_id=$1 AND id=$2', [m.tenant_id, d.kb_id])).rows[0].active_index_profile_hash; if (active && active !== g.profile_hash)
        fail(409, 'PUBLICATION_PROFILE_MISMATCH'); const row = (await c.query('SELECT * FROM document WHERE tenant_id=$1 AND id=$2', [m.tenant_id, doc])).rows[0]; if (row.latest_version_id !== version)
        fail(409, 'PUBLISH_LATEST_VERSION_REQUIRED'); const source = (await c.query('SELECT version_id FROM source_item WHERE tenant_id=$1 AND document_id=$2', [m.tenant_id, doc])).rows[0]; if (source && source.version_id !== version)
        fail(409, 'SOURCE_VERSION_CHANGED'); await c.query("UPDATE document SET status='active',published_version_id=$3,published_generation_id=$4,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2", [m.tenant_id, doc, version, generation]); await this.completePublishedJob(c, m, version, generation); await this.publicationEvent(c, m, d.kb_id, doc, null, 'publish', { version_id: row.published_version_id, generation_id: row.published_generation_id }, { version_id: version, generation_id: generation }, digest(JSON.stringify([check, review]))); await this.audit(c, m, doc, 'document.published', requestId); return this.remember(c, m, req, { document_id: doc, version_id: version, generation_id: generation, etag: docEtag({ ...d, row_version: d.row_version + 1 }) }); }); }
}
