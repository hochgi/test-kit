/**
 * Translated from v1 packages/s3/test/probed-s3-client.test.ts to v2 grammar.
 *
 * Exercises createProbedS3Adapter against the in-memory backing: round-trip put/get,
 * call recording, default forward, command() typed sugar, once().answer for
 * stubbing one command, always().answerWith for dynamic permanent answers,
 * always().reject, expect.intercept with forward/reject/answer, unsupported-
 * command failure, isolation between probed clients.
 *
 * v1 mapping:
 *   createProbedS3Client(...)              → harness.attach(createProbedS3Adapter(...))
 *   probed.client                          → s3.adapter
 *   probed.probe                           → s3.probe
 *   probed.close()                         → harness.close()
 *   probe.alwaysForward()                  → (default; no call needed)
 *   probe.alwaysReject(error)              → probe.always().reject(error)
 *   probe.alwaysAnswer(fn)                 → probe.always().answerWith(fn)
 *   probe.whenCalled(C).thenAnswer(out)    → probe.command(C).once().answer(out)
 *   probe.whenCalled(C).thenReject(err)    → probe.command(C).once().reject(err)
 *   probe.expectNext()                     → probe.expect.intercept()
 *   probe.expectMatching(p)                → probe.filter(p).expect.intercept()
 *   probe.clearBehavior()                  → probe.clearRules({ includeDefaults: true })
 *   NotImplementedError                    → templated "Cannot forward S3 command ..."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CreateMultipartUploadCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHarness, type Harness } from '@vnatures/test-kit';
import { createProbedS3Adapter, type ProbedS3Adapter } from '@vnatures/test-kit-s3';

const BUCKET = 'test-kit-s3-bucket';

async function bodyToString(body: unknown): Promise<string> {
    if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === 'function') {
        return (body as { transformToString: (enc?: string) => Promise<string> }).transformToString('utf-8');
    }
    throw new Error('Unexpected Body shape');
}

describe('createProbedS3Adapter', () => {
    let harness: Harness;
    let s3: ProbedS3Adapter;

    beforeEach(() => {
        harness = createHarness();
        s3 = harness.attach(createProbedS3Adapter({ harness, bucket: BUCKET }));
    });

    afterEach(async () => {
        await harness.close();
    });

    describe('default forward rule', () => {
        it('round-trips PutObject -> GetObject through the in-memory backing', async () => {
            await s3.adapter.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: 'hello.txt',
                    Body: 'hello, world',
                }),
            );

            const response = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }));

            expect(await bodyToString(response.Body)).toBe('hello, world');
        });

        it('records each call in probe.calls', async () => {
            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'a', Body: 'a-body' }));
            await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'a' }));

            expect(s3.probe.calls).toHaveLength(2);
            expect(s3.probe.calls[0].commandName).toBe('PutObjectCommand');
            expect(s3.probe.calls[0].input).toMatchObject({ Bucket: BUCKET, Key: 'a' });
            expect(s3.probe.calls[1].commandName).toBe('GetObjectCommand');
        });

        it('HeadObject against a missing key surfaces NoSuchKey from the in-memory backing', async () => {
            await expect(s3.adapter.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'nope' }))).rejects.toMatchObject(
                { name: 'NoSuchKey' },
            );
        });
    });

    describe('command(C).once().answer — stub one-shot', () => {
        it('answers the next matching command without touching the backend', async () => {
            s3.probe
                .command(GetObjectCommand)
                .once()
                .answer({
                    Body: { transformToString: async () => 'stubbed' },
                } as never);

            const response = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'any-key' }));
            expect(await bodyToString(response.Body)).toBe('stubbed');

            // The one-shot is consumed; subsequent gets fall back to default forward.
            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'later', Body: 'real' }));
            const real = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'later' }));
            expect(await bodyToString(real.Body)).toBe('real');
        });
    });

    describe('command(C).once().reject — error stub', () => {
        it('rejects the next matching command with the given error', async () => {
            s3.probe
                .command(GetObjectCommand)
                .once()
                .reject(
                    Object.assign(new Error('ServiceUnavailable'), {
                        name: 'ServiceUnavailable',
                        $metadata: { httpStatusCode: 503 },
                    }),
                );

            await expect(s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'a' }))).rejects.toMatchObject({
                name: 'ServiceUnavailable',
            });
        });
    });

    describe('always().answerWith — dynamic permanent default', () => {
        it('computes an answer per-call from the command input', async () => {
            s3.probe.always().answerWith(
                (call) =>
                    ({
                        Body: {
                            transformToString: async () => `answered:${(call.input as { Key: string }).Key}`,
                        },
                    }) as never,
            );

            const a = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'alpha' }));
            const b = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'beta' }));

            expect(await bodyToString(a.Body)).toBe('answered:alpha');
            expect(await bodyToString(b.Body)).toBe('answered:beta');
        });
    });

    describe('always().reject', () => {
        it('rejects every call until clearRules', async () => {
            s3.probe.always().reject(new Error('s3 down'));

            await expect(
                s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'x', Body: 'x' })),
            ).rejects.toThrow('s3 down');

            s3.probe.clearRules();

            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'recovered', Body: 'ok' }));
            const res = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'recovered' }));
            expect(await bodyToString(res.Body)).toBe('ok');
        });
    });

    describe('expect.intercept (capturing waiter)', () => {
        it('captures the next call and allows explicit forward', async () => {
            s3.probe.always().park();

            const pendingPromise = s3.probe.expect.intercept();
            const putPromise = s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: 'v' }));

            const pending = await pendingPromise;
            expect(pending.commandName).toBe('PutObjectCommand');
            expect(pending.settled).toBe(false);

            pending.forward();
            await putPromise;

            // Switch back to default behavior, then read the put we just forwarded.
            s3.probe.clearRules();
            const res = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
            expect(await bodyToString(res.Body)).toBe('v');
        });

        it('allows explicit answer via pending.answer()', async () => {
            s3.probe.always().park();

            const pendingPromise = s3.probe.expect.intercept();
            const getPromise = s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'custom' }));

            const pending = await pendingPromise;
            pending.answer({
                Body: { transformToString: async () => 'injected' },
            } as never);

            const res = await getPromise;
            expect(await bodyToString(res.Body)).toBe('injected');
        });
    });

    describe('command(C).expect.intercept — typed waiter', () => {
        it('matches calls by command class', async () => {
            s3.probe.always().park();

            const pendingPromise = s3.probe.command(GetObjectCommand).expect.intercept();
            const putPromise = s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'p', Body: 'p' }));
            const getPromise = s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'p' }));

            const pending = await pendingPromise;
            expect(pending.commandName).toBe('GetObjectCommand');

            pending.answer({
                Body: { transformToString: async () => 'matched' },
            } as never);
            const res = await getPromise;
            expect(await bodyToString(res.Body)).toBe('matched');

            // Clean up the parked Put.
            s3.probe.drainAndReject(new Error('dropped'));
            await expect(putPromise).rejects.toThrow('dropped');
        });
    });

    describe('unsupported commands fail loudly when forwarded', () => {
        it('throws a clear error when forwarding an unsupported command (default forward)', async () => {
            const failing = s3.adapter.send(
                new CreateMultipartUploadCommand({
                    Bucket: BUCKET,
                    Key: 'x',
                }) as never,
            );
            await expect(failing).rejects.toThrow(/Cannot forward S3 command/);
        });

        it('allows tests to stub unsupported commands via command().once().answer', async () => {
            s3.probe
                .command(CreateMultipartUploadCommand)
                .once()
                .answer({ UploadId: 'fake-id' } as never);

            const res = await s3.adapter.send(
                new CreateMultipartUploadCommand({
                    Bucket: BUCKET,
                    Key: 'x',
                }) as never,
            );
            expect(res).toEqual({ UploadId: 'fake-id' });
        });
    });

    describe('isolation between probed clients', () => {
        it('two probed clients keep separate state', async () => {
            const otherHarness = createHarness();
            const other = otherHarness.attach(createProbedS3Adapter({ harness: otherHarness, bucket: 'other-bucket' }));
            try {
                await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: 'from-probed' }));
                await other.adapter.send(
                    new PutObjectCommand({
                        Bucket: 'other-bucket',
                        Key: 'k',
                        Body: 'from-other',
                    }),
                );

                const a = await s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
                const b = await other.adapter.send(new GetObjectCommand({ Bucket: 'other-bucket', Key: 'k' }));

                expect(await bodyToString(a.Body)).toBe('from-probed');
                expect(await bodyToString(b.Body)).toBe('from-other');
            } finally {
                await otherHarness.close();
            }
        });

        it('reset() wipes disk state for subsequent tests', async () => {
            await s3.adapter.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: 'first' }));

            await harness.reset();

            await expect(s3.adapter.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }))).rejects.toMatchObject({
                name: 'NoSuchKey',
            });
        });
    });
});
