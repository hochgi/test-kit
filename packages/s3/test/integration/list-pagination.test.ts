/**
 * In-memory S3 backing — LIST (ListObjectsV2) pagination.
 *
 * `handleList` previously ignored `MaxKeys`/`ContinuationToken` and always
 * returned `IsTruncated: false`. These tests assert real pagination semantics:
 * honor `MaxKeys` (default 1000), emit `NextContinuationToken`, set
 * `IsTruncated`, keep prefix filtering, and produce stable lexicographic
 * order across pages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createRig, type Rig } from '@hochgi/test-kit';
import { createProbedS3Adapter, type ProbedS3Adapter } from '@hochgi/test-kit-s3';

const BUCKET = 'test-kit-s3-list-bucket';

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedS3Adapter — ListObjectsV2 pagination', () => {
    let rig: Rig;
    let s3: ProbedS3Adapter;

    beforeEach(() => {
        rig = createRig();
        s3 = rig.attach(createProbedS3Adapter({ harness: rig, bucket: BUCKET }));
    });

    afterEach(async () => {
        await rig.close();
    });

    async function seedKeys(count: number, prefix = 'k'): Promise<void> {
        for (let i = 0; i < count; i += 1) {
            // Zero-pad so lexicographic and numeric order coincide and the
            // assertions can reason about exact ordering across pages.
            const key = `${prefix}/${String(i).padStart(6, '0')}`;
            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: '' }));
        }
    }

    async function listAll(maxKeys: number): Promise<{ keys: string[]; pages: number }> {
        const keys: string[] = [];
        let pages = 0;
        let token: string | undefined;
        do {
            const res = (await s3.adapter.send(
                new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: maxKeys, ContinuationToken: token }),
            )) as {
                Contents?: Array<{ Key: string }>;
                IsTruncated?: boolean;
                NextContinuationToken?: string;
            };
            pages += 1;
            for (const c of res.Contents ?? []) keys.push(c.Key);
            token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return { keys, pages };
    }

    it('2500 keys with MaxKeys=1000 takes exactly 3 pages with stable order', async () => {
        await seedKeys(2500);

        const { keys, pages } = await listAll(1000);

        expect(pages).toBe(3);
        expect(keys).toHaveLength(2500);
        // Stable lexicographic order across pages, no duplicates, no gaps.
        const expected = Array.from({ length: 2500 }, (_, i) => `k/${String(i).padStart(6, '0')}`);
        expect(keys).toEqual(expected);
    });

    it('a malformed ContinuationToken restarts from the beginning (not an arbitrary key)', async () => {
        await seedKeys(5);
        // A bogus, non-round-trippable token must not resume from a garbage
        // key — the backing restarts from the first page.
        const res = (await s3.adapter.send(
            new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: 'not-a-real-token!!!' }),
        )) as { Contents?: Array<{ Key: string }> };
        const keys = (res.Contents ?? []).map((c) => c.Key);
        expect(keys).toEqual(Array.from({ length: 5 }, (_, i) => `k/${String(i).padStart(6, '0')}`));
    });

    it('IsTruncated is true on non-final pages and carries NextContinuationToken', async () => {
        await seedKeys(5);

        const page1 = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2 }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            NextContinuationToken?: string;
        };

        expect(page1.IsTruncated).toBe(true);
        expect(page1.NextContinuationToken).toBeDefined();
        expect(page1.Contents).toHaveLength(2);

        const page2 = (await s3.adapter.send(
            new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2, ContinuationToken: page1.NextContinuationToken }),
        )) as { Contents?: Array<{ Key: string }>; IsTruncated?: boolean; NextContinuationToken?: string };

        expect(page2.IsTruncated).toBe(true);
        expect(page2.NextContinuationToken).toBeDefined();
        expect(page2.Contents).toHaveLength(2);

        const page3 = (await s3.adapter.send(
            new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2, ContinuationToken: page2.NextContinuationToken }),
        )) as { Contents?: Array<{ Key: string }>; IsTruncated?: boolean; NextContinuationToken?: string };

        expect(page3.IsTruncated).toBe(false);
        expect(page3.NextContinuationToken).toBeUndefined();
        expect(page3.Contents).toHaveLength(1);
    });

    it('MaxKeys larger than key count returns everything in one non-truncated page', async () => {
        await seedKeys(3);

        const res = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1000 }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            KeyCount?: number;
        };

        expect(res.IsTruncated).toBe(false);
        expect(res.Contents).toHaveLength(3);
        expect(res.KeyCount).toBe(3);
    });

    it('default MaxKeys (omitted) is 1000', async () => {
        await seedKeys(1001);

        const page1 = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            KeyCount?: number;
        };

        expect(page1.IsTruncated).toBe(true);
        expect(page1.Contents).toHaveLength(1000);
        expect(page1.KeyCount).toBe(1000);
    });

    it('MaxKeys above 1000 is silently capped at 1000 (real S3 behaviour)', async () => {
        await seedKeys(1500);

        const page1 = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 5000 }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            KeyCount?: number;
            NextContinuationToken?: string;
        };

        // Must NOT return all 1500 in one page — that would hide a paging bug.
        expect(page1.Contents).toHaveLength(1000);
        expect(page1.KeyCount).toBe(1000);
        expect(page1.IsTruncated).toBe(true);
        expect(page1.NextContinuationToken).toBeDefined();

        const page2 = (await s3.adapter.send(
            new ListObjectsV2Command({
                Bucket: BUCKET,
                MaxKeys: 5000,
                ContinuationToken: page1.NextContinuationToken,
            }),
        )) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
        };

        expect(page2.Contents).toHaveLength(500);
        expect(page2.IsTruncated).toBe(false);
    });

    it('paged walk with MaxKeys=5000 over 2500 keys yields every key exactly once', async () => {
        await seedKeys(2500);

        const { keys, pages } = await listAll(5000);

        expect(pages).toBe(3); // capped at 1000 → 1000 + 1000 + 500
        expect(keys).toHaveLength(2500);
        expect(new Set(keys).size).toBe(2500);
        const expected = Array.from({ length: 2500 }, (_, i) => `k/${String(i).padStart(6, '0')}`);
        expect(keys).toEqual(expected);
    });

    it('non-finite MaxKeys (NaN) falls back to default 1000, not an empty/poisoned page', async () => {
        await seedKeys(5);

        const res = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: Number.NaN }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            KeyCount?: number;
        };

        expect(res.IsTruncated).toBe(false);
        expect(res.Contents).toHaveLength(5);
        expect(res.KeyCount).toBe(5);
    });

    it('prefix filtering is preserved across pages', async () => {
        // Two prefixes interleaved in the backing; pagination must still return only
        // the matching prefix, in order, across the correct number of pages.
        await seedKeys(3, 'alpha');
        await seedKeys(3, 'beta');

        const res = (await s3.adapter.send(
            new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'beta/', MaxKeys: 1000 }),
        )) as { Contents?: Array<{ Key: string }>; IsTruncated?: boolean; KeyCount?: number };

        expect(res.IsTruncated).toBe(false);
        expect(res.KeyCount).toBe(3);
        const keys = (res.Contents ?? []).map((c) => c.Key);
        expect(keys).toEqual(['beta/000000', 'beta/000001', 'beta/000002']);
    });

    it('continuation resumes after the exact key boundary (no overlap, no skip)', async () => {
        await seedKeys(4);

        const page1 = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2 }))) as {
            Contents?: Array<{ Key: string }>;
            NextContinuationToken?: string;
        };

        const page2 = (await s3.adapter.send(
            new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2, ContinuationToken: page1.NextContinuationToken }),
        )) as { Contents?: Array<{ Key: string }> };

        expect(page1.Contents!.map((c) => c.Key)).toEqual(['k/000000', 'k/000001']);
        expect(page2.Contents!.map((c) => c.Key)).toEqual(['k/000002', 'k/000003']);
    });

    it('MaxKeys=0 returns an empty, non-truncated page with no token (M5)', async () => {
        await seedKeys(5);

        const res = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 0 }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            NextContinuationToken?: string;
        };

        expect(res.Contents).toEqual([]);
        expect(res.IsTruncated).toBe(false);
        expect(res.NextContinuationToken).toBeUndefined();
    });

    it('Delimiter rolls up keys into CommonPrefixes and counts toward MaxKeys (M6)', async () => {
        // Keys: a/1, a/2, b/1, b/2, c.txt
        for (const key of ['a/1', 'a/2', 'b/1', 'b/2', 'c.txt']) {
            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: '' }));
        }

        const res = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: '/' }))) as {
            Contents?: Array<{ Key: string }>;
            CommonPrefixes?: Array<{ Prefix: string }>;
            IsTruncated?: boolean;
            KeyCount?: number;
        };

        // a/1, a/2 → CommonPrefixes: 'a/'
        // b/1, b/2 → CommonPrefixes: 'b/'
        // c.txt    → Contents: c.txt
        expect(res.CommonPrefixes?.map((cp) => cp.Prefix)).toEqual(['a/', 'b/']);
        expect(res.Contents?.map((c) => c.Key)).toEqual(['c.txt']);
        expect(res.IsTruncated).toBe(false);
        expect(res.KeyCount).toBe(3); // 2 common prefixes + 1 content
    });

    it('Delimiter with MaxKeys=1 paginates correctly (common prefix not split across pages)', async () => {
        for (const key of ['a/1', 'a/2', 'a/3', 'b/1']) {
            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: '' }));
        }

        const page1 = (await s3.adapter.send(
            new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: '/', MaxKeys: 1 }),
        )) as {
            CommonPrefixes?: Array<{ Prefix: string }>;
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
            NextContinuationToken?: string;
        };

        // Page 1: all a/* keys consumed as common prefix 'a/' (1 result).
        expect(page1.CommonPrefixes?.map((cp) => cp.Prefix)).toEqual(['a/']);
        expect(page1.Contents).toEqual([]);
        expect(page1.IsTruncated).toBe(true);
        expect(page1.NextContinuationToken).toBeDefined();

        const page2 = (await s3.adapter.send(
            new ListObjectsV2Command({
                Bucket: BUCKET,
                Delimiter: '/',
                MaxKeys: 1,
                ContinuationToken: page1.NextContinuationToken,
            }),
        )) as {
            CommonPrefixes?: Array<{ Prefix: string }>;
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
        };

        // Page 2: b/1 → common prefix 'b/' (1 result). Not truncated.
        expect(page2.CommonPrefixes?.map((cp) => cp.Prefix)).toEqual(['b/']);
        expect(page2.Contents).toEqual([]);
        expect(page2.IsTruncated).toBe(false);
    });

    it('StartAfter begins listing after the specified key (M7)', async () => {
        await seedKeys(5);

        const res = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, StartAfter: 'k/000002' }))) as {
            Contents?: Array<{ Key: string }>;
            IsTruncated?: boolean;
        };

        // StartAfter 'k/000002' → keys strictly after k/000002.
        expect(res.Contents?.map((c) => c.Key)).toEqual(['k/000003', 'k/000004']);
        expect(res.IsTruncated).toBe(false);
    });

    it('ContinuationToken takes precedence over StartAfter (M7)', async () => {
        await seedKeys(5);

        // First page to get a token.
        const page1 = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2 }))) as {
            NextContinuationToken?: string;
        };

        // Both StartAfter and ContinuationToken: token wins.
        // Token resumes after k/000001 (page1 ended there), NOT after k/000004.
        // With default MaxKeys=1000, all 3 remaining keys are returned.
        const res = (await s3.adapter.send(
            new ListObjectsV2Command({
                Bucket: BUCKET,
                StartAfter: 'k/000004',
                ContinuationToken: page1.NextContinuationToken,
                MaxKeys: 2,
            }),
        )) as { Contents?: Array<{ Key: string }> };

        expect(res.Contents?.map((c) => c.Key)).toEqual(['k/000002', 'k/000003']);
    });

    it('keys are sorted by UTF-8 byte order, not UTF-16 code-unit order (L4)', async () => {
        // U+F000 (UTF-8: EF 80 80) and U+10000 (UTF-8: F0 90 80 80).
        // UTF-8 byte order: U+F000 < U+10000 (EF < F0).
        // UTF-16 code-unit order: U+10000 < U+F000 (D800 < F000).
        // S3 uses UTF-8, so 'x\uf000' must come before 'x\U00010000'.
        const keyLow = 'x\uf000'; // U+F000
        const keyHigh = 'x\uD800\uDC00'; // U+10000 (surrogate pair)
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: keyLow, Body: '' }));
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: keyHigh, Body: '' }));

        const res = (await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1000 }))) as {
            Contents?: Array<{ Key: string }>;
        };

        expect(res.Contents!.map((c) => c.Key)).toEqual([keyLow, keyHigh]);
    });
});
