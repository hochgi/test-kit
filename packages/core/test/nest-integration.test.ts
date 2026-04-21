/**
 * Regression test for the NestJS lifecycle-hook hang fix.
 *
 * Before the fix, a test-kit fake used as a NestJS provider value via
 * `.overrideProvider(Token).useValue(fake)` would deadlock `app.init()`:
 *
 *   1. Nest scans each provider INSTANCE with `typeof instance[hook] === 'function'`.
 *      Detection is purely runtime; the provider class's declared interfaces
 *      are irrelevant to hook invocation.
 *   2. The fake's Proxy returned a call-recording function for ANY property
 *      name, so Nest saw `onModuleInit` as callable on the fake.
 *   3. Nest invoked `fake.onModuleInit()`, which recorded a probe call whose
 *      deferred promise had no programmed behavior.
 *   4. `app.init()` awaited that promise forever.
 *
 * The fix adds Nest's five canonical lifecycle hook names to the Proxy's
 * `passthroughProps` so the trap returns `undefined`, and Nest's detection
 * check falls through.
 *
 * This test exercises the full Nest lifecycle (init + close) against a fake
 * registered via `.overrideProvider(...).useValue(fake)` — the exact pattern
 * the PR description calls out. It complements the isolated Proxy trap test
 * in `probe.test.ts`.
 */
/* eslint-disable max-classes-per-file -- Nest idiom: one provider class + one module class. */
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createProbePair } from '../src/probe';

interface Bedrock {
    send(cmd: { id: number }): Promise<{ ok: boolean }>;
}

@Injectable()
class BedrockService implements Bedrock {
    async send(_cmd: { id: number }): Promise<{ ok: boolean }> {
        return { ok: true };
    }
}

@Module({ providers: [BedrockService], exports: [BedrockService] })
class BedrockModule {}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

describe('NestJS provider integration', () => {
    it('fake survives app.init() and app.close() as .useValue(fake)', async () => {
        const { fake, probe } = createProbePair<Bedrock>();

        const moduleRef = await Test.createTestingModule({
            imports: [BedrockModule],
        })
            .overrideProvider(BedrockService)
            .useValue(fake)
            .compile();

        // Nest walks every provider and invokes detected lifecycle hooks here.
        // Without the passthrough fix, the fake's Proxy returned a call-
        // recording function for `onModuleInit` / `onApplicationBootstrap`,
        // and this line would hang indefinitely.
        await withTimeout(moduleRef.init(), 2000, 'moduleRef.init()');

        probe.alwaysReturn('send', { ok: true });
        const bedrock = moduleRef.get<Bedrock>(BedrockService);
        const result = await bedrock.send({ id: 42 });

        expect(result).toEqual({ ok: true });
        expect(probe.calls).toEqual([{ method: 'send', args: [{ id: 42 }] }]);

        // close() walks onModuleDestroy + beforeApplicationShutdown +
        // onApplicationShutdown on every provider. None may hang.
        await withTimeout(moduleRef.close(), 2000, 'moduleRef.close()');
    });
});
