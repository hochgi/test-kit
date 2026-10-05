/**
 * In-memory S3 backing — conditional requests (IfMatch / IfNoneMatch).
 *
 * Real S3 rejects conditional writes that fail preconditions with 412, and
 * returns 304 NotModified for matching IfNoneMatch on GET/HEAD. Without
 * this, optimistic-concurrency and create-if-absent writes cannot be tested
 * against the backing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createRig, type Rig } from '@hochgi/test-kit';
import { createProbedS3Adapter, type ProbedS3Adapter } from '@hochgi/test-kit-s3';

const BUCKET = 'test-kit-s3-conditional-bucket';

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedS3Adapter — conditional requests', () => {
    let rig: Rig;
    let s3: ProbedS3Adapter;

    beforeEach(() => {
        rig = createRig();
        s3 = rig.attach(createProbedS3Adapter({ harness: rig, bucket: BUCKET }));
    });

    afterEach(async () => {
        await rig.close();
    });

    async function put(key: string, body: string): Promise<string> {
        const res = await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
        return res.ETag as string;
    }

    describe('GetObject / HeadObject IfMatch', () => {
        it('succeeds when IfMatch equals the current ETag', async () => {
            const etag = await put('k', 'v1');

            const get = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k', IfMatch: etag }));
            expect(get.ETag).toBe(etag);

            const head = await s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'k', IfMatch: etag }));
            expect(head.ETag).toBe(etag);
        });

        it('returns 412 PreconditionFailed when IfMatch differs', async () => {
            await put('k', 'v1');

            await expect(
                s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k', IfMatch: '"deadbeef"' })),
            ).rejects.toMatchObject({
                name: 'PreconditionFailed',
                message: expect.stringContaining(`${BUCKET}/k`),
                $metadata: { httpStatusCode: 412 },
            });

            await expect(
                s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'k', IfMatch: '"deadbeef"' })),
            ).rejects.toMatchObject({
                name: 'PreconditionFailed',
                message: expect.stringContaining(`${BUCKET}/k`),
                $metadata: { httpStatusCode: 412 },
            });
        });
    });

    describe('GetObject / HeadObject IfNoneMatch', () => {
        it('returns 304 NotModified when IfNoneMatch equals the current ETag', async () => {
            const etag = await put('k', 'v1');

            await expect(
                s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k', IfNoneMatch: etag })),
            ).rejects.toMatchObject({
                name: 'NotModified',
                message: expect.stringContaining(`${BUCKET}/k`),
                $metadata: { httpStatusCode: 304 },
            });

            await expect(
                s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'k', IfNoneMatch: etag })),
            ).rejects.toMatchObject({
                name: 'NotModified',
                message: expect.stringContaining(`${BUCKET}/k`),
                $metadata: { httpStatusCode: 304 },
            });
        });

        it('succeeds when IfNoneMatch differs from the current ETag', async () => {
            const etag = await put('k', 'v1');

            const get = await s3.adapter.send(
                new GetObjectCommand({ Bucket: BUCKET, Key: 'k', IfNoneMatch: '"other"' }),
            );
            expect(get.ETag).toBe(etag);
        });
    });

    describe('PutObject IfNoneMatch / IfMatch', () => {
        it('IfNoneMatch: "*" returns 412 when the key already exists (create-only)', async () => {
            await put('k', 'v1');

            await expect(
                s3.adapter.send(
                    new PutObjectCommand({
                        Bucket: BUCKET,
                        Key: 'k',
                        Body: 'v2',
                        IfNoneMatch: '*',
                    }),
                ),
            ).rejects.toMatchObject({
                name: 'PreconditionFailed',
                $metadata: { httpStatusCode: 412 },
            });

            // Object unchanged.
            const get = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
            expect(get.ETag).toBeDefined();
            const body = await (get.Body as { transformToString: () => Promise<string> }).transformToString();
            expect(body).toBe('v1');
        });

        it('IfNoneMatch: "*" succeeds when the key does not exist', async () => {
            const putRes = await s3.adapter.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: 'new-key',
                    Body: 'fresh',
                    IfNoneMatch: '*',
                }),
            );
            expect(putRes.ETag).toBeDefined();
        });

        it('IfMatch returns 412 when the current ETag differs (compare-and-swap)', async () => {
            await put('k', 'v1');

            await expect(
                s3.adapter.send(
                    new PutObjectCommand({
                        Bucket: BUCKET,
                        Key: 'k',
                        Body: 'v2',
                        IfMatch: '"stale-etag"',
                    }),
                ),
            ).rejects.toMatchObject({
                name: 'PreconditionFailed',
                $metadata: { httpStatusCode: 412 },
            });
        });

        it('IfMatch succeeds when the current ETag matches (compare-and-swap)', async () => {
            const etag = await put('k', 'v1');

            const putRes = await s3.adapter.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: 'k',
                    Body: 'v2',
                    IfMatch: etag,
                }),
            );
            expect(putRes.ETag).toBeDefined();
            expect(putRes.ETag).not.toBe(etag);

            const get = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
            const body = await (get.Body as { transformToString: () => Promise<string> }).transformToString();
            expect(body).toBe('v2');
        });
    });
});
