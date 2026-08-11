/**
 * In-memory S3 backing — review-follow-up regressions.
 *
 * Covers invariants that are awkward to assert through the probed adapter
 * alone (empty-bucket leak on failed CAS) or that pin review fixes
 * (Buffer clone, non-finite MaxKeys).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryS3Backing } from '../../src/s3-client/in-memory-backing.js';

function md5Etag(body: Buffer): string {
    return `"${createHash('md5').update(body).digest('hex')}"`;
}

describe('InMemoryS3Backing — review regressions', () => {
    it('failed IfMatch Put does not create an empty bucket', async () => {
        const backing = new InMemoryS3Backing([]);
        expect(backing.hasBucket('ghost')).toBe(false);

        await expect(
            backing.dispatch('PutObjectCommand', {
                Bucket: 'ghost',
                Key: 'k',
                Body: 'x',
                IfMatch: '"nope"',
            }),
        ).rejects.toMatchObject({ name: 'PreconditionFailed' });

        expect(backing.hasBucket('ghost')).toBe(false);
    });

    it('successful Put still auto-initializes a missing bucket', async () => {
        const backing = new InMemoryS3Backing([]);
        await backing.dispatch('PutObjectCommand', {
            Bucket: 'new-bucket',
            Key: 'k',
            Body: 'ok',
        });
        expect(backing.hasBucket('new-bucket')).toBe(true);
        expect(backing.has('new-bucket', 'k')).toBe(true);
    });

    it('mutating the caller Buffer after Put does not change stored bytes or ETag', async () => {
        const backing = new InMemoryS3Backing(['b']);
        const buf = Buffer.from('original');
        const put = (await backing.dispatch('PutObjectCommand', {
            Bucket: 'b',
            Key: 'k',
            Body: buf,
        })) as { ETag: string };

        expect(put.ETag).toBe(md5Etag(Buffer.from('original')));
        buf.write('MUTATED!');

        const get = (await backing.dispatch('GetObjectCommand', {
            Bucket: 'b',
            Key: 'k',
        })) as {
            ETag: string;
            Body: { transformToString: () => Promise<string> };
        };
        expect(get.ETag).toBe(put.ETag);
        expect(await get.Body.transformToString()).toBe('original');
    });

    it('non-finite MaxKeys falls back to the default of 1000', async () => {
        const backing = new InMemoryS3Backing(['b']);
        for (let i = 0; i < 5; i += 1) {
            await backing.dispatch('PutObjectCommand', {
                Bucket: 'b',
                Key: `k/${i}`,
                Body: '',
            });
        }

        const res = (await backing.dispatch('ListObjectsV2Command', {
            Bucket: 'b',
            MaxKeys: Number.NaN,
        })) as { Contents?: unknown[]; IsTruncated?: boolean; KeyCount?: number };

        expect(res.IsTruncated).toBe(false);
        expect(res.Contents).toHaveLength(5);
        expect(res.KeyCount).toBe(5);
    });
});
