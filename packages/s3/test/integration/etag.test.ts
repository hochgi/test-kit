/**
 * In-memory S3 backing — body-derived ETags.
 *
 * ETag must be the MD5 of the stored body (quoted), matching real AWS
 * semantics for non-multipart objects. A key-derived ETag cannot represent
 * "same key, rewritten bytes" — the replaced-content case consumers need
 * to detect.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CopyObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';
import { createRig, type Rig } from '@hochgi/test-kit';
import { createProbedS3Adapter, type ProbedS3Adapter } from '@hochgi/test-kit-s3';

const BUCKET = 'test-kit-s3-etag-bucket';

function md5Etag(body: string | Buffer): string {
    return `"${createHash('md5').update(body).digest('hex')}"`;
}

describe('createProbedS3Adapter — body-derived ETags', () => {
    let rig: Rig;
    let s3: ProbedS3Adapter;

    beforeEach(() => {
        rig = createRig();
        s3 = rig.attach(createProbedS3Adapter({ harness: rig, bucket: BUCKET }));
    });

    afterEach(async () => {
        await rig.close();
    });

    it('a rewritten object reports a different ETag (replaced-content detection)', async () => {
        const key = 'device/batch.ndjson.gz';
        const bodyV1 = Buffer.from('{"id":1}\n{"id":2}\n');
        const bodyV2 = Buffer.from('{"id":1}\n{"id":2}\n{"id":3}\n');

        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: gzipSync(bodyV1) }));
        const first = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: gzipSync(bodyV2) }));
        const second = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

        expect(first.ETag).toBeDefined();
        expect(second.ETag).toBeDefined();
        expect(first.ETag).not.toBe(second.ETag);
    });

    it('Put/Get/Head ETag equals MD5 of the body (quoted)', async () => {
        const body = 'hello, etag';
        const put = await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'a.txt', Body: body }));
        expect(put.ETag).toBe(md5Etag(body));

        const get = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'a.txt' }));
        expect(get.ETag).toBe(md5Etag(body));

        const head = await s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'a.txt' }));
        expect(head.ETag).toBe(md5Etag(body));
    });

    it('identical bytes under different keys share an ETag (correct AWS behaviour)', async () => {
        const body = 'same-bytes';
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k1', Body: body }));
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k2', Body: body }));

        const a = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k1' }));
        const b = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k2' }));

        expect(a.ETag).toBe(b.ETag);
        expect(a.ETag).toBe(md5Etag(body));
    });

    it('CopyObject reports the ETag of the copied body (equals source)', async () => {
        const body = 'copy-me';
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'src', Body: body }));
        const src = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'src' }));

        const copy = await s3.adapter.send(
            new CopyObjectCommand({
                Bucket: BUCKET,
                Key: 'dst',
                CopySource: `${BUCKET}/src`,
            }),
        );

        expect(copy.CopyObjectResult?.ETag).toBe(src.ETag);
        expect(copy.CopyObjectResult?.ETag).toBe(md5Etag(body));

        const dst = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'dst' }));
        expect(dst.ETag).toBe(src.ETag);
    });

    it('PutObjectTagging does not change the object ETag', async () => {
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'tagged', Body: 'body' }));
        const before = await s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'tagged' }));

        await s3.adapter.send(
            new PutObjectTaggingCommand({
                Bucket: BUCKET,
                Key: 'tagged',
                Tagging: { TagSet: [{ Key: 'env', Value: 'test' }] },
            }),
        );

        const after = await s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'tagged' }));
        expect(after.ETag).toBe(before.ETag);
    });

    it('ListObjectsV2 Contents.ETag matches the body-derived ETag', async () => {
        const body = 'listed';
        await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'listed.txt', Body: body }));

        const list = await s3.adapter.send(new ListObjectsV2Command({ Bucket: BUCKET }));
        const entry = list.Contents?.find((c) => c.Key === 'listed.txt');
        expect(entry?.ETag).toBe(md5Etag(body));
    });
});
