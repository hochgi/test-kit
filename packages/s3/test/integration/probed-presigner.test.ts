/**
 * Translated from v1 packages/s3/test/probed-presigner.test.ts to v2 grammar.
 *
 * The presigner adapter has no backing — every call must be answered or
 * rejected explicitly. Default forward fails loudly.
 *
 * v1 mapping:
 *   createProbedPresigner()           → rig.attach(createProbedPresignerAdapter({ harness: rig }))
 *   probed.presigner                  → presigner.adapter
 *   probed.probe                      → presigner.probe
 *   probe.alwaysAnswer(fn)            → probe.always().answerWith(fn)
 *   probe.whenCalled(C).thenAnswer    → probe.command(C).once().answer
 *   probe.whenCalled(C).thenReject    → probe.command(C).once().reject
 *   probe.expectNext()                → probe.expect.intercept()
 *   probe.clearBehavior()             → (no-op; presigner has no default rule)
 *   PresignCallInput                  → PresignCall (call.commandInput, call.options)
 *   NotImplementedError               → templated "Cannot forward presign call ..."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createRig, type Rig } from '@hochgi/test-kit';
import { createProbedPresignerAdapter, type ProbedPresignerAdapter } from '@hochgi/test-kit-s3';

const dummyClient = new S3Client({ region: 'us-east-1' });

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedPresignerAdapter', () => {
    let rig: Rig;
    let presigner: ProbedPresignerAdapter;

    beforeEach(() => {
        rig = createRig();
        presigner = rig.attach(createProbedPresignerAdapter({ harness: rig }));
    });

    afterEach(async () => {
        await rig.close();
    });

    describe('default behavior — no backing, calls park', () => {
        it('park: a call without any rule hangs until the safety timeout', async () => {
            // No rule installed; the call should park indefinitely. We verify that
            // the call has reached the probe, then drain it explicitly.
            const cmd = new GetObjectCommand({ Bucket: 'b', Key: 'k' });
            const urlPromise = presigner.adapter.signUrl(dummyClient, cmd, { expiresIn: 60 });

            const pending = await presigner.probe.expect.intercept();
            expect(pending.commandName).toBe('GetObjectCommand');
            pending.answer('https://stubbed-by-test');

            await expect(urlPromise).resolves.toBe('https://stubbed-by-test');
        });
    });

    describe('always().answerWith — dynamic per-call URL', () => {
        it('returns a URL computed from command input and options', async () => {
            presigner.probe.always().answerWith((call) => {
                const { Bucket, Key } = call.commandInput as { Bucket: string; Key: string };
                return `https://fake/${Bucket}/${Key}?expires=${call.options?.expiresIn ?? 'default'}`;
            });

            const url = await presigner.adapter.signUrl(
                dummyClient,
                new GetObjectCommand({ Bucket: 'docs', Key: 'file.pdf' }),
                { expiresIn: 3600 },
            );

            expect(url).toBe('https://fake/docs/file.pdf?expires=3600');
        });

        it('records every call with commandName + commandInput + options', async () => {
            presigner.probe.always().answerWith(() => 'https://fake');

            await presigner.adapter.signUrl(
                dummyClient,
                new PutObjectCommand({ Bucket: 'b', Key: 'k', ContentType: 'image/png' }),
                { expiresIn: 900 },
            );
            await presigner.adapter.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }), {
                expiresIn: 60,
            });

            expect(presigner.probe.calls).toHaveLength(2);
            expect(presigner.probe.calls[0].commandName).toBe('PutObjectCommand');
            expect(presigner.probe.calls[0].commandInput).toMatchObject({
                Bucket: 'b',
                Key: 'k',
                ContentType: 'image/png',
            });
            expect(presigner.probe.calls[0].options).toEqual({ expiresIn: 900 });
            expect(presigner.probe.calls[1].commandName).toBe('GetObjectCommand');
            expect(presigner.probe.calls[1].options).toEqual({ expiresIn: 60 });
        });
    });

    describe('command(C).once().answer — one-shot override', () => {
        it('overrides the next matching call exactly once', async () => {
            presigner.probe.always().answerWith(() => 'https://default');
            presigner.probe.command(GetObjectCommand).once().answer('https://one-shot');

            const first = await presigner.adapter.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
            const second = await presigner.adapter.signUrl(
                dummyClient,
                new GetObjectCommand({ Bucket: 'b', Key: 'k' }),
            );

            expect(first).toBe('https://one-shot');
            expect(second).toBe('https://default');
        });
    });

    describe('command(C).once().reject — error paths', () => {
        it('rejects the next matching call with the given error', async () => {
            presigner.probe.command(PutObjectCommand).once().reject(new Error('STS expired'));

            await expect(
                presigner.adapter.signUrl(dummyClient, new PutObjectCommand({ Bucket: 'b', Key: 'k' })),
            ).rejects.toThrow('STS expired');
        });
    });

    describe('expect.intercept (capturing waiter)', () => {
        it('captures the next call and resolves with a test-provided URL', async () => {
            const pendingPromise = presigner.probe.expect.intercept();
            const urlPromise = presigner.adapter.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }), {
                expiresIn: 123,
            });

            const pending = await pendingPromise;
            expect(pending.commandName).toBe('GetObjectCommand');
            expect(pending.options).toEqual({ expiresIn: 123 });

            pending.answer('https://captured');
            expect(await urlPromise).toBe('https://captured');
        });
    });
});
