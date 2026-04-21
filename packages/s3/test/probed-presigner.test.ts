import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { createProbedPresigner, NotImplementedError, PresignCallInput, ProbedPresigner } from '../src';

const dummyClient = new S3Client({ region: 'us-east-1' });

describe('createProbedPresigner', () => {
    let probed: ProbedPresigner;

    beforeEach(() => {
        probed = createProbedPresigner();
    });

    describe('default behavior (alwaysForward) — no real backend', () => {
        it('throws NotImplementedError when no answer is programmed', async () => {
            const cmd = new GetObjectCommand({ Bucket: 'b', Key: 'k' });
            await expect(probed.presigner.signUrl(dummyClient, cmd, { expiresIn: 60 })).rejects.toBeInstanceOf(
                NotImplementedError,
            );
        });
    });

    describe('alwaysAnswer() — dynamic per-call URL', () => {
        it('returns a URL computed from command input and options', async () => {
            probed.probe.alwaysAnswer((call) => {
                const { commandInput, options } = call.input as PresignCallInput;
                const { Bucket, Key } = commandInput as { Bucket: string; Key: string };
                return `https://fake/${Bucket}/${Key}?expires=${options?.expiresIn ?? 'default'}`;
            });

            const url = await probed.presigner.signUrl(
                dummyClient,
                new GetObjectCommand({ Bucket: 'docs', Key: 'file.pdf' }),
                { expiresIn: 3600 },
            );

            expect(url).toBe('https://fake/docs/file.pdf?expires=3600');
        });

        it('records every call with commandName + commandInput + options', async () => {
            probed.probe.alwaysAnswer(() => 'https://fake');

            await probed.presigner.signUrl(
                dummyClient,
                new PutObjectCommand({ Bucket: 'b', Key: 'k', ContentType: 'image/png' }),
                { expiresIn: 900 },
            );
            await probed.presigner.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }), {
                expiresIn: 60,
            });

            expect(probed.probe.calls).toHaveLength(2);
            expect(probed.probe.calls[0].commandName).toBe('PutObjectCommand');
            expect((probed.probe.calls[0].input as PresignCallInput).commandInput).toMatchObject({
                Bucket: 'b',
                Key: 'k',
                ContentType: 'image/png',
            });
            expect((probed.probe.calls[0].input as PresignCallInput).options).toEqual({ expiresIn: 900 });
            expect(probed.probe.calls[1].commandName).toBe('GetObjectCommand');
            expect((probed.probe.calls[1].input as PresignCallInput).options).toEqual({ expiresIn: 60 });
        });
    });

    describe('whenCalled().thenAnswer() — one-shot override', () => {
        it('overrides the next matching call exactly once', async () => {
            probed.probe.alwaysAnswer(() => 'https://default');
            probed.probe.whenCalled(GetObjectCommand).thenAnswer('https://one-shot');

            const first = await probed.presigner.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
            const second = await probed.presigner.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }));

            expect(first).toBe('https://one-shot');
            expect(second).toBe('https://default');
        });
    });

    describe('whenCalled().thenReject() — error paths', () => {
        it('rejects the next matching call with the given error', async () => {
            probed.probe.whenCalled(PutObjectCommand).thenReject(new Error('STS expired'));

            await expect(
                probed.presigner.signUrl(dummyClient, new PutObjectCommand({ Bucket: 'b', Key: 'k' })),
            ).rejects.toThrow('STS expired');
        });
    });

    describe('expectNext() plumbing', () => {
        it('captures the next call and resolves with a test-provided URL', async () => {
            probed.probe.clearBehavior();

            const pendingPromise = probed.probe.expectNext();
            const urlPromise = probed.presigner.signUrl(dummyClient, new GetObjectCommand({ Bucket: 'b', Key: 'k' }), {
                expiresIn: 123,
            });

            const pending = await pendingPromise;
            expect(pending.commandName).toBe('GetObjectCommand');
            expect((pending.input as PresignCallInput).options).toEqual({ expiresIn: 123 });

            pending.answer('https://captured');
            expect(await urlPromise).toBe('https://captured');
        });
    });
});
