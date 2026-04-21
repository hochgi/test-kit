import {
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    CreateMultipartUploadCommand,
} from '@aws-sdk/client-s3';

import { createProbedS3Client, NotImplementedError, ProbedS3 } from '../src';

const BUCKET = 'test-kit-s3-bucket';

async function bodyToString(body: unknown): Promise<string> {
    if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === 'function') {
        return (body as { transformToString: (enc?: string) => Promise<string> }).transformToString('utf-8');
    }
    throw new Error('Unexpected Body shape');
}

describe('createProbedS3Client', () => {
    let probed: ProbedS3;

    beforeEach(() => {
        probed = createProbedS3Client({ bucket: BUCKET });
    });

    afterEach(async () => {
        await probed.close();
    });

    describe('alwaysForward (default passthrough)', () => {
        it('round-trips PutObject -> GetObject through mock-aws-s3-v3 disk', async () => {
            await probed.client.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: 'hello.txt',
                    Body: 'hello, world',
                }),
            );

            const response = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }));

            expect(await bodyToString(response.Body)).toBe('hello, world');
        });

        it('records each call in the probe with the exact command input', async () => {
            await probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'a', Body: 'a-body' }));
            await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'a' }));

            expect(probed.probe.calls).toHaveLength(2);
            expect(probed.probe.calls[0].commandName).toBe('PutObjectCommand');
            expect(probed.probe.calls[0].input).toMatchObject({ Bucket: BUCKET, Key: 'a' });
            expect(probed.probe.calls[1].commandName).toBe('GetObjectCommand');
        });

        it('HeadObject against a missing key surfaces NoSuchKey (mock-aws-s3-v3 semantics)', async () => {
            await expect(
                probed.client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'nope' })),
            ).rejects.toMatchObject({ name: 'NoSuchKey' });
        });
    });

    describe('whenCalled().thenAnswer() — stub one-shot', () => {
        it('answers the next matching command without touching the backend', async () => {
            probed.probe.whenCalled(GetObjectCommand).thenAnswer({
                Body: { transformToString: async () => 'stubbed' },
            });

            const response = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'any-key' }));
            expect(await bodyToString(response.Body)).toBe('stubbed');

            // The stub only applies once — subsequent calls fall back to alwaysForward.
            await probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'later', Body: 'real' }));
            const real = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'later' }));
            expect(await bodyToString(real.Body)).toBe('real');
        });
    });

    describe('whenCalled().thenReject() — stub error', () => {
        it('rejects the next matching command with the given error', async () => {
            probed.probe.whenCalled(GetObjectCommand).thenReject(
                Object.assign(new Error('ServiceUnavailable'), {
                    name: 'ServiceUnavailable',
                    $metadata: { httpStatusCode: 503 },
                }),
            );

            await expect(probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'a' }))).rejects.toMatchObject({
                name: 'ServiceUnavailable',
            });
        });
    });

    describe('alwaysAnswer() — permanent dynamic default', () => {
        it('computes an answer per-call from the command input', async () => {
            probed.probe.alwaysAnswer((call) => ({
                Body: {
                    transformToString: async () => `answered:${(call.input as { Key: string }).Key}`,
                },
            }));

            const a = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'alpha' }));
            const b = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'beta' }));

            expect(await bodyToString(a.Body)).toBe('answered:alpha');
            expect(await bodyToString(b.Body)).toBe('answered:beta');
        });
    });

    describe('alwaysReject()', () => {
        it('rejects every call until reset', async () => {
            probed.probe.alwaysReject(new Error('s3 down'));

            await expect(
                probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'x', Body: 'x' })),
            ).rejects.toThrow('s3 down');

            probed.probe.alwaysForward();

            await probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'recovered', Body: 'ok' }));
            const res = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'recovered' }));
            expect(await bodyToString(res.Body)).toBe('ok');
        });
    });

    describe('expectNext() plumbing', () => {
        it('captures the next call and allows explicit forward', async () => {
            probed.probe.clearBehavior();

            const pendingPromise = probed.probe.expectNext();
            const putPromise = probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: 'v' }));

            const pending = await pendingPromise;
            expect(pending.commandName).toBe('PutObjectCommand');
            expect(pending.settled).toBe(false);

            pending.forward();
            await putPromise;

            probed.probe.alwaysForward();
            const res = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
            expect(await bodyToString(res.Body)).toBe('v');
        });

        it('allows explicit answer via pending.answer()', async () => {
            probed.probe.clearBehavior();

            const pendingPromise = probed.probe.expectNext();
            const getPromise = probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'custom' }));

            const pending = await pendingPromise;
            pending.answer({ Body: { transformToString: async () => 'injected' } });

            const res = await getPromise;
            expect(await bodyToString(res.Body)).toBe('injected');
        });
    });

    describe('expectMatching() plumbing', () => {
        it('matches calls by command name', async () => {
            probed.probe.clearBehavior();

            const pendingPromise = probed.probe.expectMatching((c) => c.commandName === 'GetObjectCommand');
            const putPromise = probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'p', Body: 'p' }));
            const getPromise = probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'p' }));

            // PutObject is unhandled (forward not set, no plan) — drain it.
            probed.probe.drainAndForwardAll.bind(probed.probe);
            // Actually the above line just binds; we need to call `drainAndForwardAll`
            // only on the pending Put. Explicitly handle:
            // Route the pending Put through forward by pre-answering via a second expect.
            // Simpler: answer the Get, then forward the Put via pending drain.
            const pending = await pendingPromise;
            pending.answer({ Body: { transformToString: async () => 'matched' } });
            const res = await getPromise;
            expect(await bodyToString(res.Body)).toBe('matched');

            // Clean up the pending Put.
            probed.probe.drainAndRejectAll(new Error('dropped'));
            await expect(putPromise).rejects.toThrow('dropped');
        });
    });

    describe('NotImplementedError on unsupported commands', () => {
        it('throws NotImplementedError when forward is attempted for an unsupported command', async () => {
            // Default is alwaysForward — an unsupported command should fail loudly.
            const failing = probed.client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'x' }) as never);
            await expect(failing).rejects.toBeInstanceOf(NotImplementedError);
        });

        it('allows tests to stub unsupported commands via whenCalled().thenAnswer()', async () => {
            probed.probe.whenCalled(CreateMultipartUploadCommand).thenAnswer({ UploadId: 'fake-id' });

            const res = await probed.client.send(
                new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'x' }) as never,
            );
            expect(res).toEqual({ UploadId: 'fake-id' });
        });
    });

    describe('isolation', () => {
        it('two probed clients keep separate state', async () => {
            const other = createProbedS3Client({ bucket: 'other-bucket' });
            try {
                await probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: 'from-probed' }));
                await other.client.send(new PutObjectCommand({ Bucket: 'other-bucket', Key: 'k', Body: 'from-other' }));

                const a = await probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
                const b = await other.client.send(new GetObjectCommand({ Bucket: 'other-bucket', Key: 'k' }));

                expect(await bodyToString(a.Body)).toBe('from-probed');
                expect(await bodyToString(b.Body)).toBe('from-other');
            } finally {
                await other.close();
            }
        });

        it('reset() wipes disk state for subsequent tests', async () => {
            await probed.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: 'first' }));

            probed.reset();

            await expect(probed.client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }))).rejects.toMatchObject({
                name: 'NoSuchKey',
            });
        });
    });
});
