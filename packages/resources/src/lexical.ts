import { createHash } from 'node:crypto';
import { fail } from './policy';
/** Repository examples, not organization-approved synonyms. Keep query and corpus on the same vocabulary. */
export const DOMAIN_TERMS = ['单点登录', '费用报销', '差旅报销', '住宿上限', '知识中枢', '访问控制', '采购审批', '故障恢复', '数据保留', '离职交接'] as const;
export const LEXICAL_VERSION = `zh-icu-terms-bm25-v1/icu-${process.versions.icu}`;
export const DICTIONARY_HASH = createHash('sha256').update(JSON.stringify(DOMAIN_TERMS)).digest('hex');
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
export const normalizeLexical = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g, '-');
const ascii = /[a-z0-9]+(?:[._+/#-][a-z0-9]+)*/gy;
const terms = [...DOMAIN_TERMS].sort((a, b) => b.length - a.length);
const stop = new Set(['的', '了', '和', '与', '是', '在', '如何', '什么', '请', '怎么', '吗', '呢']);
export function tokenize(text: string): string[] {
    const s = normalizeLexical(text), out: string[] = [];
    let i = 0;
    while (i < s.length) {
        ascii.lastIndex = i;
        const code = ascii.exec(s);
        if (code) {
            out.push(code[0]);
            i = ascii.lastIndex;
            continue;
        }
        const term = terms.find(t => s.startsWith(t, i));
        if (term) {
            out.push(term);
            i += term.length;
            continue;
        }
        // Segment the next Chinese run; stop before a domain term so longest-match terms stay intact.
        if (/\p{Script=Han}/u.test(s[i]!)) {
            let end = i + 1;
            while (end < s.length && /\p{Script=Han}/u.test(s[end]!) && !terms.some(t => s.startsWith(t, end)))
                end++;
            for (const piece of segmenter.segment(s.slice(i, end)))
                if (piece.isWordLike && !stop.has(piece.segment))
                    out.push(piece.segment);
            i = end;
        }
        else
            i++;
    }
    return out;
}
export function lexicalQuery(query: string) {
    const normalized = normalizeLexical(query), phrases: string[] = [];
    let rest = normalized;
    // Quotes request literal normalized substrings. ASCII identifier boundaries are still mandatory.
    rest = rest.replace(/"([^"\n]+)"/g, (_, p: string) => { phrases.push(p); return p; });
    if (rest.includes('"') || phrases.length > 8)
        fail(400, 'INVALID_LEXICAL_PHRASE');
    const tokens = [...new Set(tokenize(rest))];
    if (tokens.length > 64)
        fail(400, 'LEXICAL_QUERY_TOO_BROAD');
    return { tokens, phrases };
}
function hasPhrase(text: string, phrase: string) { let from = 0; while (from <= text.length) {
    const at = text.indexOf(phrase, from);
    if (at < 0)
        return false;
    const before = text[at - 1], after = text[at + phrase.length];
    if (!(/[a-z0-9]/.test(phrase[0]!) && before && /[a-z0-9._+/#-]/.test(before)) && !(/[a-z0-9]/.test(phrase.at(-1)!) && after && /[a-z0-9._+/#-]/.test(after)))
        return true;
    from = at + 1;
} return false; }
/** BM25 k1=1.2, b=.75; DF and average length come only from this authorized snapshot. */
export function bm25(texts: string[], query: string): number[] {
    const q = lexicalQuery(query), documents = texts.map(t => { const counts = new Map<string, number>(); const words = tokenize(t); for (const w of words)
        counts.set(w, (counts.get(w) ?? 0) + 1); return { counts, length: words.length, text: normalizeLexical(t) }; });
    if (documents.reduce((n, d) => n + d.length, 0) > 500000)
        fail(422, 'LEXICAL_SCOPE_TOO_LARGE');
    const average = documents.reduce((n, d) => n + d.length, 0) / Math.max(1, documents.length) || 1;
    const df = new Map(q.tokens.map(t => [t, documents.filter(d => d.counts.has(t)).length]));
    const identifiers = q.tokens.filter(t => /[a-z]/.test(t) && (/[0-9]/.test(t) || /[._+/#-]/.test(t)));
    return documents.map(d => { if (identifiers.length && !identifiers.some(t => d.counts.has(t)))
        return 0; if (q.phrases.some(p => !hasPhrase(d.text, p)))
        return 0; let score = 0; for (const t of q.tokens) {
        const tf = d.counts.get(t) ?? 0;
        if (!tf)
            continue;
        const count = df.get(t)!;
        score += Math.log(1 + (documents.length - count + .5) / (count + .5)) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * d.length / average));
    } return score; });
}
