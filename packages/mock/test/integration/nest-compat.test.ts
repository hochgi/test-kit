/**
 * Translated from v1 packages/core/test/nest-integration.test.ts.
 *
 * Regression test for NestJS lifecycle-hook compatibility: a probed mock
 * registered as a NestJS provider via `.useValue(...)` must not hang
 * `app.init()` or `app.close()` when Nest scans it for canonical
 * lifecycle hooks (onModuleInit, onApplicationBootstrap,
 * onModuleDestroy, beforeApplicationShutdown, onApplicationShutdown).
 *
 * v2's contract makes this trivially correct: the proxy returns
 * `undefined` for any property not in the `methods` allowlist, so Nest's
 * `typeof instance[hook] === 'function'` check fails and Nest never tries
 * to invoke a hook on the adapter.
 */
/* eslint-disable max-classes-per-file */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createProbedMock } from '@vnatures/test-kit-mock';

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
    it('probed mock survives app.init() and app.close() as .useValue(adapter)', async () => {
        const { adapter, probe } = createProbedMock<Bedrock>({ methods: ['send'] });

        const moduleRef = await Test.createTestingModule({
            imports: [BedrockModule],
        })
            .overrideProvider(BedrockService)
            .useValue(adapter)
            .compile();

        // Nest scans every provider for lifecycle hooks here. Without v2's
        // explicit `methods` allowlist (every other key returns undefined),
        // this would hang.
        await withTimeout(moduleRef.init(), 2000, 'moduleRef.init()');

        probe.on('send').always().answer({ ok: true });
        const bedrock = moduleRef.get<Bedrock>(BedrockService);
        const result = await bedrock.send({ id: 42 });

        expect(result).toEqual({ ok: true });
        expect(probe.calls).toEqual([{ method: 'send', args: [{ id: 42 }] }]);

        // close() walks onModuleDestroy + beforeApplicationShutdown +
        // onApplicationShutdown on every provider. None may hang.
        await withTimeout(moduleRef.close(), 2000, 'moduleRef.close()');
    });
});
