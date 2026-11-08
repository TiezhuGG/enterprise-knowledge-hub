import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
export const sourceHash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export class SourceFailure extends Error {
    constructor(readonly code: string, readonly retryMs = 0) { super(code); }
}
const invalid = (): never => { throw new SourceFailure('SOURCE_PROTOCOL_INVALID'); };
const keys = (v: any, allowed: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
export interface SourceBinding {
    ref: string;
    tenant_id: string;
    kb_id: string;
    source_id: string;
    root: string;
    key_env: string;
    freshness_seconds: number;
    principals: Record<string, {
        type: 'member' | 'group';
        id: string;
    }>;
    hash: string;
    mapping_hash: string;
}
export function connectorSettings(env: NodeJS.ProcessEnv = process.env) { if (env.CONNECTORS_ENABLED !== undefined && !['true', 'false'].includes(env.CONNECTORS_ENABLED))
    throw new Error('Invalid CONNECTORS_ENABLED'); const poll = Number(env.CONNECTOR_POLL_MS ?? 1000), interval = Number(env.CONNECTOR_SYNC_INTERVAL_SECONDS ?? 60); if (!Number.isInteger(poll) || poll < 100 || poll > 60000 || !Number.isInteger(interval) || interval < 5 || interval > 900)
    throw new Error('Invalid connector interval'); return { enabled: env.CONNECTORS_ENABLED === 'true', pollMs: poll, intervalSeconds: interval }; }
export async function sourceBinding(ref: string, tenant: string, kb: string, env: NodeJS.ProcessEnv = process.env): Promise<SourceBinding> {
    let configs: any;
    try {
        configs = JSON.parse(env.DIRECTORY_SOURCES_JSON ?? '{}');
    }
    catch {
        throw new SourceFailure('SOURCE_CONFIG_INVALID');
    }
    const v = configs?.[ref];
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ref) || !keys(v, ['tenant_id', 'kb_id', 'source_id', 'root', 'key_env', 'freshness_seconds', 'principals']) || v.tenant_id !== tenant || v.kb_id !== kb)
        throw new SourceFailure('SOURCE_NOT_CONFIGURED');
    if (!text(v.source_id) || !text(v.root, 1000) || !isAbsolute(v.root) || !/^[_A-Z][_A-Z0-9]{0,100}$/.test(v.key_env) || !v.principals || typeof v.principals !== 'object' || Array.isArray(v.principals) || Object.keys(v.principals).length > 200)
        throw new SourceFailure('SOURCE_CONFIG_INVALID');
    const freshness = v.freshness_seconds ?? 900;
    if (!Number.isInteger(freshness) || freshness < 30 || freshness > 900)
        throw new SourceFailure('SOURCE_CONFIG_INVALID');
    const principals: SourceBinding['principals'] = Object.create(null);
    for (const [key, p] of Object.entries(v.principals) as Array<[
        string,
        any
    ]>) {
        if (!text(key) || !keys(p, ['type', 'id']) || !['member', 'group'].includes(p.type) || !/^[a-f0-9-]{36}$/.test(p.id))
            throw new SourceFailure('SOURCE_CONFIG_INVALID');
        principals[key] = p;
    }
    let root: string;
    try {
        root = await realpath(v.root);
        if ((await lstat(v.root)).isSymbolicLink() || !(await lstat(root)).isDirectory())
            throw new Error();
    }
    catch {
        throw new SourceFailure('SOURCE_DIRECTORY_UNAVAILABLE');
    }
    const hash = sourceHash(JSON.stringify([tenant, kb, ref, v.source_id, root, v.key_env, freshness])), mapping_hash = sourceHash(JSON.stringify(Object.entries(principals).sort(([a], [b]) => a.localeCompare(b))));
    return { ref, tenant_id: tenant, kb_id: kb, source_id: v.source_id, root, key_env: v.key_env, freshness_seconds: freshness, principals, hash, mapping_hash };
}
export function signSourceHead(payload: unknown, key: string) { return { payload, signature: createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex') }; }
export interface SourceEvent {
    seq: number;
    external_id: string;
    revision: string;
    kind: 'upsert' | 'acl' | 'delete';
    readers?: string[];
    file?: string;
    filename?: string;
    mime?: string;
    size?: number;
    sha256?: string;
}
export interface SourcePage {
    start_seq: number;
    end_seq: number;
    sha256: string;
    file: string;
}
export interface SourceSnapshot {
    end: number;
    validUntil: Date;
    pages: SourcePage[];
    events: SourceEvent[];
}
export class DirectorySource {
    constructor(readonly binding: SourceBinding, private readonly env: NodeJS.ProcessEnv = process.env) { }
    async read(path: string, max: number) {
        if (typeof path !== 'string' || !path || path.length > 500 || isAbsolute(path) || path.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || path.includes('\\') || /[\u0000-\u001f]/.test(path))
            throw new SourceFailure('SOURCE_PATH_REJECTED');
        let handle;
        try {
            const full = resolve(this.binding.root, path), rel = relative(this.binding.root, full);
            if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
                throw new SourceFailure('SOURCE_PATH_REJECTED');
            let part = this.binding.root;
            for (const component of path.split('/')) {
                part = resolve(part, component);
                if ((await lstat(part)).isSymbolicLink())
                    throw new SourceFailure('SOURCE_PATH_REJECTED');
            }
            handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
                throw new SourceFailure('SOURCE_FILE_LIMIT');
            const actual = await realpath(`/proc/self/fd/${handle.fd}`), actualRel = relative(this.binding.root, actual);
            if (actualRel === '..' || actualRel.startsWith('..' + sep) || isAbsolute(actualRel))
                throw new SourceFailure('SOURCE_PATH_REJECTED');
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: max })) {
                size += chunk.length;
                if (size > max)
                    throw new SourceFailure('SOURCE_FILE_LIMIT');
                chunks.push(Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
        }
        catch (e) {
            if (e instanceof SourceFailure)
                throw e;
            if (['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? ''))
                throw new SourceFailure('SOURCE_AUTH_FAILED');
            throw new SourceFailure('SOURCE_DIRECTORY_UNAVAILABLE');
        }
        finally {
            await handle?.close();
        }
    }
    async snapshot(): Promise<SourceSnapshot> {
        const secret = this.env[this.binding.key_env];
        if (!secret || secret.length < 32)
            throw new SourceFailure('SOURCE_AUTH_FAILED');
        let head: any;
        try {
            head = JSON.parse((await this.read('HEAD.json', 65536)).toString('utf8'));
        }
        catch (e) {
            if (e instanceof SourceFailure)
                throw e;
            return invalid();
        }
        if (!keys(head, ['payload', 'signature']) || typeof head.signature !== 'string' || !/^[a-f0-9]{64}$/.test(head.signature))
            throw new SourceFailure('SOURCE_AUTH_FAILED');
        const expected = signSourceHead(head.payload, secret).signature;
        if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(head.signature, 'hex')))
            throw new SourceFailure('SOURCE_AUTH_FAILED');
        const p = head.payload, now = Date.now();
        if (!keys(p, ['schema', 'source_id', 'issued_at', 'valid_until', 'end_seq', 'pages', 'not_before']) || p.schema !== 'directory-feed-v1' || p.source_id !== this.binding.source_id || !Number.isSafeInteger(p.end_seq) || p.end_seq < 0 || !Array.isArray(p.pages) || p.pages.length > 50)
            invalid();
        const issued = Date.parse(p.issued_at), until = Date.parse(p.valid_until);
        if (!Number.isFinite(issued) || !Number.isFinite(until) || issued > now + 30000 || until <= issued || until - issued > this.binding.freshness_seconds * 1000)
            invalid();
        if (until <= now)
            throw new SourceFailure('SOURCE_ATTESTATION_EXPIRED');
        if (p.not_before !== undefined) {
            const wait = Date.parse(p.not_before) - now;
            if (!Number.isFinite(wait) || wait > 900000)
                invalid();
            if (wait > 0)
                throw new SourceFailure('SOURCE_RATE_LIMIT', wait);
        }
        const events: SourceEvent[] = [], pages: SourcePage[] = [];
        let next = 1, total = 0;
        for (const ref of p.pages) {
            if (!keys(ref, ['start_seq', 'end_seq', 'sha256', 'file']) || ref.start_seq !== next || !Number.isSafeInteger(ref.end_seq) || ref.end_seq < ref.start_seq || ref.end_seq - ref.start_seq >= 100 || !/^[a-f0-9]{64}$/.test(ref.sha256) || !text(ref.file, 500))
                invalid();
            const bytes = await this.read(ref.file, 2097152);
            total += bytes.length;
            if (total > 12582912)
                throw new SourceFailure('SOURCE_FILE_LIMIT');
            if (sourceHash(bytes) !== ref.sha256)
                throw new SourceFailure('SOURCE_PAGE_MISMATCH');
            let rows: any;
            try {
                rows = JSON.parse(bytes.toString('utf8'));
            }
            catch {
                return invalid();
            }
            if (!Array.isArray(rows) || rows.length !== ref.end_seq - ref.start_seq + 1)
                invalid();
            for (const e of rows) {
                if (!keys(e, ['seq', 'external_id', 'revision', 'kind', 'readers', 'file', 'filename', 'mime', 'size', 'sha256']) || e.seq !== next || !text(e.external_id) || !/^[a-zA-Z0-9._:-]{1,200}$/.test(e.external_id) || !text(e.revision) || !['upsert', 'acl', 'delete'].includes(e.kind))
                    invalid();
                if (e.kind !== 'delete' && (!Array.isArray(e.readers) || e.readers.length > 100 || e.readers.some((r: unknown) => !text(r))))
                    invalid();
                if (e.kind === 'upsert' && (!text(e.file, 500) || !text(e.filename, 255) || !text(e.mime) || !Number.isInteger(e.size) || e.size < 1 || e.size > 52428800 || !/^[a-f0-9]{64}$/.test(e.sha256)))
                    invalid();
                events.push(e);
                next++;
            }
            pages.push(ref);
        }
        if (next - 1 !== p.end_seq)
            invalid();
        return { end: p.end_seq, validUntil: new Date(until), events, pages };
    }
    async content(e: SourceEvent) { const bytes = await this.read(e.file!, e.size!); if (bytes.length !== e.size || sourceHash(bytes) !== e.sha256)
        throw new SourceFailure('SOURCE_CONTENT_MISMATCH'); return bytes; }
}
