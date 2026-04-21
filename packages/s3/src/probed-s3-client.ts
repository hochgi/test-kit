import { S3Client } from '@aws-sdk/client-s3';
import { createS3Client, resetMocks } from 'mock-aws-s3-v3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3Probe } from './s3-probe';
import { NotImplementedError } from './errors';

/**
 * Commands mock-aws-s3-v3 implements end-to-end (disk-backed) and that
 * `.forward()` can safely dispatch. Any command outside this set will throw
 * `NotImplementedError` on forward; tests must stub it explicitly via
 * `probe.whenCalled(Cmd).thenAnswer(...)` / `probe.alwaysAnswer(...)`.
 *
 * Source: mock-aws-s3-v3 v6.1.13 (`dist/src/mockS3.js`).
 */
const SUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
    'PutObjectCommand',
    'GetObjectCommand',
    'CreateBucketCommand',
    'DeleteBucketCommand',
    'ListObjectsCommand',
    'ListObjectsV2Command',
    'DeleteObjectsCommand',
    'DeleteObjectCommand',
    'HeadObjectCommand',
    'CopyObjectCommand',
    'GetObjectTaggingCommand',
    'PutObjectTaggingCommand',
]);

export interface ProbedS3ClientOptions {
    /** Bucket name the fake responds for. Typically the same name production uses. */
    readonly bucket: string;
    /**
     * Filesystem directory where the fake persists object bodies. Defaults to a
     * per-instance tmpdir under `os.tmpdir()`. You rarely need to override this.
     */
    readonly localDirectory?: string;
}

export interface ProbedS3 {
    readonly client: S3Client;
    readonly probe: S3Probe;
    readonly bucket: string;
    readonly localDirectory: string;
    /**
     * Wipes stored objects and the mock-aws-s3-v3 bucket context so the next
     * `.send()` starts from a clean slate. Safe to call between tests.
     */
    reset(): void;
    /**
     * Like `reset()` but also removes the tmpdir entirely. Call at suite teardown.
     */
    close(): Promise<void>;
}

/**
 * Probed S3 fake: returns an `S3Client`-shaped object whose `.send()` is
 * intercepted by an `S3Probe`. By default (no behavior programmed) every call
 * is forwarded to a mock-aws-s3-v3 backend rooted at a per-instance tmpdir —
 * so `PutObject` + `GetObject` round-trip real buffers. Any command outside
 * mock-aws-s3-v3's supported set throws `NotImplementedError` on forward; tests
 * opt into answering unsupported commands explicitly.
 */
export function createProbedS3Client(opts: ProbedS3ClientOptions): ProbedS3 {
    const { bucket } = opts;
    if (!bucket || typeof bucket !== 'string') {
        throw new Error('createProbedS3Client: `bucket` (string) is required.');
    }

    const localDirectory = opts.localDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'test-kit-s3-'));
    fs.mkdirSync(localDirectory, { recursive: true });

    // mock-aws-s3-v3 keys its internal bucket contexts by bucket name in a
    // module-global Map. Always reset up-front so stale state from a previous
    // (leaked) probe never leaks into this one.
    resetMocks(bucket);

    let inner: S3Client | null = null;
    const ensureInner = (): S3Client => {
        if (!inner) {
            inner = createS3Client({ localDirectory, bucket });
        }
        return inner;
    };

    const probe = new S3Probe();

    // The client we hand back is a fresh S3Client whose `.send` is replaced
    // to route through the probe. We don't rely on the middleware pipeline —
    // neither for real requests (none) nor for `answer(...)` payloads (the
    // probe resolves with the caller's exact object).
    const client = new S3Client({ region: 'us-east-1' });
    const probedSend = (command: unknown): Promise<unknown> => {
        const commandName =
            (command as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'UnknownCommand';
        const input = (command as { input?: unknown } | null)?.input ?? {};
        return probe.recordCall(commandName, input, () => {
            if (!SUPPORTED_COMMANDS.has(commandName)) {
                return Promise.reject(
                    new NotImplementedError(
                        commandName,
                        'mock-aws-s3-v3 has no backing implementation for this command',
                    ),
                );
            }
            // Dispatch the user's actual command to the mock-aws-s3-v3 client.
            return ensureInner().send(command as never) as Promise<unknown>;
        });
    };
    // Override own property shadows the S3Client.prototype.send method.
    (client as unknown as { send: typeof probedSend }).send = probedSend;

    return {
        client,
        probe,
        bucket,
        localDirectory,
        reset() {
            resetMocks(bucket);
            inner = null;
            try {
                fs.rmSync(path.join(localDirectory, bucket), { recursive: true, force: true });
            } catch {
                // best-effort
            }
        },
        close(): Promise<void> {
            resetMocks(bucket);
            inner = null;
            try {
                fs.rmSync(localDirectory, { recursive: true, force: true });
            } catch {
                // best-effort
            }
            return Promise.resolve();
        },
    };
}
