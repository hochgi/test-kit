/**
 * Translated from v1 packages/core/test/porcelain.test.ts to v2 grammar.
 *
 *   probe.whenCalled(method).thenReturn(v)  → probe.on(method).once().answer(v)
 *   probe.whenCalled(method).thenReject(e)  → probe.on(method).once().reject(e)
 *   probe.whenCalled(method).thenCall(fn)   → probe.on(method).once().answerWith(fn)
 *   probe.alwaysReturn(method, v)           → probe.on(method).always().answer(v)
 *   probe.alwaysReject(method, e)           → probe.on(method).always().reject(e)
 *   probe.alwaysCall(method, fn)            → probe.on(method).always().answerWith(fn)
 *
 * One-shot rules in v2 fire in registration order (FIFO at tier 2);
 * one-shots beat permanents unconditionally.
 */
import { describe, expect, it } from 'vitest';
import { createProbedMock } from '@vnatures/test-kit-mock';

interface DemoService {
    getById(id: number): Promise<{ id: number }>;
    getName(id: number): Promise<string>;
}

describe('once() — one-shot rules', () => {
    it('answer() auto-resolves the next call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').once().answer('gilad');
        await expect(adapter.getName(1)).resolves.toBe('gilad');
    });

    it('reject() auto-rejects the next call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').once().reject(new Error('forbidden'));
        await expect(adapter.getName(1)).rejects.toThrow('forbidden');
    });

    it('answerWith() delegates to a function of the call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe
            .on('getById')
            .once()
            .answerWith((call) => {
                const id = call.args[0] as number;
                return Promise.resolve({ id: id + 100 });
            });
        await expect(adapter.getById(3)).resolves.toEqual({ id: 103 });
    });

    it('a fired one-shot is removed; the next call is not auto-handled', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').once().answer('first');
        await expect(adapter.getName(1)).resolves.toBe('first');

        void adapter.getName(2);
        const pending = await probe.expect.intercept();
        expect(pending.method).toBe('getName');
        expect(pending.args).toEqual([2]);
        expect(pending.settled).toBe(false);
    });

    it('two sequential one-shots fire in registration order (FIFO)', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').once().answer('first');
        probe.on('getName').once().answer('second');

        await expect(adapter.getName(1)).resolves.toBe('first');
        await expect(adapter.getName(2)).resolves.toBe('second');
    });
});

describe('always() — permanent rules', () => {
    it('always().answer() answers every matching call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').always().answer('permanent');

        await expect(adapter.getName(1)).resolves.toBe('permanent');
        await expect(adapter.getName(2)).resolves.toBe('permanent');
        await expect(adapter.getName(3)).resolves.toBe('permanent');
    });

    it('always().reject() rejects every matching call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').always().reject(new Error('always fails'));

        await expect(adapter.getName(1)).rejects.toThrow('always fails');
        await expect(adapter.getName(2)).rejects.toThrow('always fails');
    });

    it('always().answerWith() delegates every matching call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe
            .on('getById')
            .always()
            .answerWith((call) => ({
                id: (call.args[0] as number) * 10,
            }));

        await expect(adapter.getById(1)).resolves.toEqual({ id: 10 });
        await expect(adapter.getById(5)).resolves.toEqual({ id: 50 });
    });

    it('one-shot beats permanent (tier 2 > tier 3)', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'getName'],
        });
        probe.on('getName').always().answer('permanent');
        probe.on('getName').once().answer('override');

        await expect(adapter.getName(1)).resolves.toBe('override'); // one-shot fires
        await expect(adapter.getName(2)).resolves.toBe('permanent'); // one-shot consumed; permanent fires
    });
});
