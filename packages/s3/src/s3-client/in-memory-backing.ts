/**
 * In-memory S3 backing.
 *
 * Replaces the previous `mock-aws-s3-v3` dependency with a dispatcher keyed
 * on `command.constructor.name` (a plain string), which works across SDK-
 * copy duplication scenarios — a common pitfall when test-kit is consumed
 * via `file:` references, workspace overrides, or in monorepos with
 * non-hoisted dependencies.
 *
 * Supports the same SUPPORTED_COMMANDS surface as before: PutObject,
 * GetObject, HeadObject, DeleteObject, DeleteObjects, ListObjects,
 * ListObjectsV2, CopyObject, GetObjectTagging, PutObjectTagging,
 * CreateBucket, DeleteBucket. Unsupported commands throw a clear error
 * via the dispatcher's caller (see `unsupportedForward` in core errors).
 *
 * Body content for GetObject is returned as a Node `Readable` stream
 * (the AWS SDK's wire shape) plus `transformToString`/`transformToByteArray`
 * helpers to mirror the SDK response shape.
 */
import { Readable } from 'node:stream';
import { NoSuchKey } from '@aws-sdk/client-s3';

export interface S3StoredObject {
    readonly body: Buffer;
    readonly contentType?: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly tagSet?: ReadonlyArray<{ Key: string; Value: string }>;
    readonly lastModified: Date;
}

interface BucketIndex {
    readonly objects: Map<string, S3StoredObject>; // key (without bucket)
}

export class InMemoryS3Backing {
    private readonly buckets = new Map<string, BucketIndex>();

    constructor(initialBuckets: ReadonlyArray<string> = []) {
        for (const b of initialBuckets) this.ensureBucket(b);
    }

    /** Wipe every bucket's contents (but keep the buckets themselves). */
    reset(): void {
        for (const idx of this.buckets.values()) idx.objects.clear();
    }

    /** Drop everything — buckets and objects. */
    clear(): void {
        this.buckets.clear();
    }

    /** Pre-seed an object directly (test fixture helper). */
    put(bucket: string, key: string, obj: S3StoredObject): void {
        const idx = this.ensureBucket(bucket);
        idx.objects.set(key, obj);
    }

    has(bucket: string, key: string): boolean {
        return this.buckets.get(bucket)?.objects.has(key) ?? false;
    }

    /**
     * Dispatch a command (identified by constructor name) against the
     * backing. Returns a Promise mirroring the AWS SDK response shape.
     *
     * Throws AWS-shaped errors (e.g. `NoSuchKey`) for the canonical
     * not-found cases. Returns `undefined` when the command is not in
     * the supported set — the caller (factory.ts) decides whether that's
     * the loud-failure case or a passthrough.
     */
    async dispatch(commandName: string, input: unknown): Promise<unknown> {
        const i = (input ?? {}) as Record<string, unknown>;

        switch (commandName) {
            case 'PutObjectCommand':
                return this.handlePut(i);

            case 'GetObjectCommand':
                return this.handleGet(i);

            case 'HeadObjectCommand':
                return this.handleHead(i);

            case 'DeleteObjectCommand':
                return this.handleDelete(i);

            case 'DeleteObjectsCommand':
                return this.handleDeleteMany(i);

            case 'ListObjectsCommand':
            case 'ListObjectsV2Command':
                return this.handleList(i);

            case 'CopyObjectCommand':
                return this.handleCopy(i);

            case 'GetObjectTaggingCommand':
                return this.handleGetTagging(i);

            case 'PutObjectTaggingCommand':
                return this.handlePutTagging(i);

            case 'CreateBucketCommand': {
                this.ensureBucket(i.Bucket as string);
                return {};
            }

            case 'DeleteBucketCommand': {
                this.buckets.delete(i.Bucket as string);
                return {};
            }

            default:
                // Caller (the factory) decides what to do for unsupported
                // commands. We signal "not supported" by returning undefined.
                return undefined;
        }
    }

    // ── Per-command handlers ───────────────────────────────────────────────

    private handlePut(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const key = input.Key as string;
        const idx = this.ensureBucket(bucket);
        idx.objects.set(key, {
            body: toBuffer(input.Body),
            contentType: input.ContentType as string | undefined,
            metadata: input.Metadata as Record<string, string> | undefined,
            lastModified: new Date(),
        });
        return { ETag: makeEtag(key) };
    }

    private handleGet(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const key = input.Key as string;
        const obj = this.buckets.get(bucket)?.objects.get(key);
        if (!obj) {
            throw makeNoSuchKey(`${bucket}/${key}`);
        }
        return {
            Body: makeBodyStream(obj.body),
            ContentType: obj.contentType,
            ContentLength: obj.body.byteLength,
            Metadata: obj.metadata,
            LastModified: obj.lastModified,
            ETag: makeEtag(key),
        };
    }

    private handleHead(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const key = input.Key as string;
        const obj = this.buckets.get(bucket)?.objects.get(key);
        if (!obj) {
            throw makeNoSuchKey(`${bucket}/${key}`);
        }
        return {
            ContentType: obj.contentType,
            ContentLength: obj.body.byteLength,
            Metadata: obj.metadata,
            LastModified: obj.lastModified,
            ETag: makeEtag(key),
        };
    }

    private handleDelete(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const key = input.Key as string;
        this.buckets.get(bucket)?.objects.delete(key);
        return {};
    }

    private handleDeleteMany(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const idx = this.buckets.get(bucket);
        const objects = (input.Delete as { Objects?: Array<{ Key: string }> })?.Objects ?? [];
        const deleted: Array<{ Key: string }> = [];
        if (idx) {
            for (const obj of objects) {
                if (idx.objects.delete(obj.Key)) deleted.push({ Key: obj.Key });
            }
        }
        return { Deleted: deleted };
    }

    private handleList(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const prefix = (input.Prefix as string | undefined) ?? '';
        const idx = this.buckets.get(bucket);
        const contents: Array<Record<string, unknown>> = [];
        if (idx) {
            for (const [key, obj] of idx.objects) {
                if (key.startsWith(prefix)) {
                    contents.push({
                        Key: key,
                        Size: obj.body.byteLength,
                        LastModified: obj.lastModified,
                        ETag: makeEtag(key),
                    });
                }
            }
        }
        return { Contents: contents, KeyCount: contents.length, IsTruncated: false };
    }

    private handleCopy(input: Record<string, unknown>): Record<string, unknown> {
        const destBucket = input.Bucket as string;
        const destKey = input.Key as string;
        // CopySource format: "bucket/key" (URL-encoded by SDK; we accept raw too)
        const copySource = decodeURIComponent(input.CopySource as string);
        const slash = copySource.indexOf('/');
        if (slash < 0) {
            throw new Error(`Malformed CopySource: ${copySource}`);
        }
        const srcBucket = copySource.slice(0, slash).replace(/^\//, '');
        const srcKey = copySource.slice(slash + 1);
        const srcObj = this.buckets.get(srcBucket)?.objects.get(srcKey);
        if (!srcObj) {
            throw makeNoSuchKey(`${srcBucket}/${srcKey}`);
        }
        this.ensureBucket(destBucket).objects.set(destKey, {
            ...srcObj,
            lastModified: new Date(),
        });
        return {
            CopyObjectResult: {
                ETag: makeEtag(destKey),
                LastModified: new Date(),
            },
        };
    }

    private handleGetTagging(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const key = input.Key as string;
        const obj = this.buckets.get(bucket)?.objects.get(key);
        if (!obj) {
            throw makeNoSuchKey(`${bucket}/${key}`);
        }
        return { TagSet: obj.tagSet ?? [] };
    }

    private handlePutTagging(input: Record<string, unknown>): Record<string, unknown> {
        const bucket = input.Bucket as string;
        const key = input.Key as string;
        const idx = this.buckets.get(bucket);
        const obj = idx?.objects.get(key);
        if (!idx || !obj) {
            throw makeNoSuchKey(`${bucket}/${key}`);
        }
        const tagSet =
            ((input.Tagging as { TagSet?: Array<{ Key: string; Value: string }> })?.TagSet as
                | ReadonlyArray<{ Key: string; Value: string }>
                | undefined) ?? [];
        idx.objects.set(key, { ...obj, tagSet });
        return {};
    }

    private ensureBucket(bucket: string): BucketIndex {
        let idx = this.buckets.get(bucket);
        if (!idx) {
            idx = { objects: new Map() };
            this.buckets.set(bucket, idx);
        }
        return idx;
    }
}

function toBuffer(value: unknown): Buffer {
    if (value === undefined || value === null) return Buffer.alloc(0);
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'object' && 'pipe' in (value as object)) {
        // Streamed Body inputs aren't supported in this in-memory backing.
        // Tests that need streamed uploads should pre-buffer.
        throw new Error('In-memory S3 backing does not support stream Body inputs. Buffer the content first.');
    }
    return Buffer.from(String(value));
}

function makeBodyStream(buf: Buffer): Readable & {
    transformToString(encoding?: BufferEncoding): Promise<string>;
    transformToByteArray(): Promise<Uint8Array>;
} {
    const stream = Readable.from(buf) as Readable & {
        transformToString(encoding?: BufferEncoding): Promise<string>;
        transformToByteArray(): Promise<Uint8Array>;
    };
    // Mirror the AWS SDK GetObject Body shape: it's a Readable that also has
    // helper methods. Tests that use these helpers (very common) work without
    // having to drain the stream manually.
    stream.transformToString = async (encoding: BufferEncoding = 'utf-8') => buf.toString(encoding);
    stream.transformToByteArray = async () => new Uint8Array(buf);
    return stream;
}

function makeEtag(key: string): string {
    // AWS-style ETag is the MD5 hash of the body in quotes. We use a stable
    // string derived from the key so tests can assert on it without computing
    // hashes. This deviates from real AWS behavior but matches tests that
    // typically don't pin ETag values.
    return `"${Buffer.from(key).toString('hex').slice(0, 32)}"`;
}

function makeNoSuchKey(label: string): Error {
    // Use the SDK's NoSuchKey class so consumers can do `instanceof NoSuchKey`
    // (within the same SDK copy) AND so the .name property is 'NoSuchKey'
    // (which works cross-SDK-copy via duck-type checks like `err.name === 'NoSuchKey'`).
    return new NoSuchKey({
        message: `The specified key does not exist (${label}).`,
        $metadata: { httpStatusCode: 404 },
    });
}
